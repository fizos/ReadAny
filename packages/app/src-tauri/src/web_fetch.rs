use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::Serialize;
use tokio::net::lookup_host;
use tokio::time::timeout;

const MAX_REDIRECTS: usize = 5;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_URL_LENGTH: usize = 4096;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Serialize)]
pub struct SafeWebFetchResponse {
    pub final_url: String,
    pub status: u16,
    pub content_type: String,
    pub body: String,
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    let first = octets[0];
    let second = octets[1];

    // Reject private, loopback, link-local, multicast, unspecified, and the
    // special-use ranges which must never be reachable from this command.
    !(first == 0
        || first == 10
        || first == 127
        || (first == 100 && (64..=127).contains(&second)) // shared address space
        || (first == 169 && second == 254) // link-local
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0)
        || (first == 192 && second == 168)
        || (first == 192 && second == 2) // TEST-NET-1
        || (first == 198 && (18..=19).contains(&second)) // benchmark
        || (first == 198 && second == 51) // TEST-NET-2
        || (first == 203 && second == 0 && octets[2] == 113) // TEST-NET-3
        || first >= 224) // multicast and reserved
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let first = segments[0];

    // The explicit checks cover IPv4-mapped addresses and the special-use
    // IPv6 blocks not covered by std::net's convenience predicates.
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || (first & 0xffc0) == 0xfe80 // link-local, including non-canonical forms
        || (first & 0xff00) == 0xff00 // multicast
        || (segments[..5].iter().all(|segment| *segment == 0)
            && segments[5] == 0xffff) // IPv4-mapped addresses
        || (first == 0x2001 && segments[1] == 0x0000) // protocol assignments
        || (first == 0x2001 && segments[1] == 0x0002) // benchmark
        || (first == 0x2001 && segments[1] == 0x0db8) // documentation
        || (first == 0x3fff) // documentation (RFC 9637)
        || (first == 0x0100 && segments[1..].iter().all(|segment| *segment == 0)))
}

fn validate_url(url: &Url) -> Result<(), String> {
    if url.as_str().len() > MAX_URL_LENGTH {
        return Err("URL is too long".to_string());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https URLs are supported".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs containing user credentials are not allowed".to_string());
    }
    if url.host_str().is_none() {
        return Err("URL must include a hostname".to_string());
    }
    Ok(())
}

async fn resolve_public_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let lookup_target = (host, port);
    let addresses = timeout(DNS_TIMEOUT, lookup_host(lookup_target))
        .await
        .map_err(|_| "DNS lookup timed out".to_string())?
        .map_err(|error| format!("DNS lookup failed: {error}"))?;

    let mut public_addresses = Vec::new();
    for address in addresses {
        if !is_public_ip(address.ip()) {
            return Err(format!(
                "DNS resolved to a non-public address: {}",
                address.ip()
            ));
        }
        public_addresses.push(address);
    }
    if public_addresses.is_empty() {
        return Err("DNS returned no addresses".to_string());
    }
    Ok(public_addresses)
}

fn content_type(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default()
}

fn is_readable_content_type(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || matches!(
            content_type,
            "application/xhtml+xml"
                | "application/xml"
                | "text/xml"
                | "application/rss+xml"
                | "application/atom+xml"
                | "application/json"
        )
}

async fn fetch_one(url: &Url) -> Result<reqwest::Response, String> {
    validate_url(url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a hostname".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "URL has no usable port".to_string())?;
    let addresses = resolve_public_addresses(host, port).await?;

    // Build a fresh client for every hop. no_proxy prevents environment proxy
    // settings from bypassing the DNS/IP policy, while resolve_to_addrs pins
    // the request to the addresses checked above without changing Host/SNI.
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(DNS_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .resolve_to_addrs(host, addresses.as_slice())
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))?;

    client
        .get(url.clone())
        .header(
            reqwest::header::USER_AGENT,
            "ReadAny/1.3.6 (+https://github.com/codedogQBY/ReadAny)",
        )
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,text/plain,application/xml,application/rss+xml,application/json;q=0.9,*/*;q=0.1")
        .send()
        .await
        .map_err(|error| format!("HTTP request failed: {error}"))
}

async fn read_limited_body(response: reqwest::Response) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("failed to read response body: {error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(format!(
                "response body exceeds {MAX_BODY_BYTES} bytes after decompression"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| "response body is not valid UTF-8".to_string())
}

/// Fetch an untrusted web page through a tightly constrained desktop-side
/// network path. Redirects are handled manually so DNS and content policy are
/// re-applied to every hop.
#[tauri::command]
pub async fn safe_web_fetch(url: String) -> Result<SafeWebFetchResponse, String> {
    let mut current = Url::parse(&url).map_err(|error| format!("invalid URL: {error}"))?;
    validate_url(&current)?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let response = fetch_one(&current).await?;
        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Err(format!("too many redirects (maximum {MAX_REDIRECTS})"));
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| "redirect response has no Location header".to_string())?
                .to_str()
                .map_err(|_| "redirect Location header is invalid".to_string())?;
            current = current
                .join(location)
                .map_err(|error| format!("invalid redirect URL: {error}"))?;
            validate_url(&current)?;
            continue;
        }

        let status = response.status();
        let content_type = content_type(&response);
        if !is_readable_content_type(&content_type) {
            return Err(format!(
                "unsupported or missing Content-Type: {content_type:?}"
            ));
        }
        let body = read_limited_body(response).await?;
        return Ok(SafeWebFetchResponse {
            final_url: current.to_string(),
            status: status.as_u16(),
            content_type,
            body,
        });
    }

    Err("too many redirects".to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_public_ip, is_readable_content_type};
    use std::net::IpAddr;

    #[test]
    fn rejects_private_and_special_use_addresses() {
        for address in [
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "192.168.1.1",
            "198.18.0.1",
            "203.0.113.10",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "2001:2::1",
        ] {
            assert!(
                !is_public_ip(address.parse::<IpAddr>().unwrap()),
                "{address}"
            );
        }
    }

    #[test]
    fn permits_public_addresses_and_readable_content_types() {
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
        assert!(is_readable_content_type("text/html"));
        assert!(is_readable_content_type("application/rss+xml"));
        assert!(!is_readable_content_type("application/octet-stream"));
    }
}

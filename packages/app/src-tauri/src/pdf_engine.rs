//! The native boundary for the optional high-fidelity PDF engine.
//!
//! The Python worker is deliberately treated as an untrusted, short-lived
//! helper.  This module owns its paths, its input transport, its lifetime and
//! the result boundary.  In particular, credentials are only serialized to
//! the worker's stdin; they are never command-line arguments or files.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock, Weak};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;
use uuid::Uuid;

const MAX_JOBS: usize = 32;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_INPUT_BYTES: u64 = 500 * 1024 * 1024;
const MAX_RESULT_BYTES: u64 = 20 * 1024 * 1024;
const MAX_EXPORT_BYTES: u64 = 500 * 1024 * 1024;
const MAX_TRANSLATION_CONTEXT_BYTES: usize = 24_000;
const SETUP_DEADLINE: Duration = Duration::from_secs(20 * 60);
const TRANSLATE_DEADLINE: Duration = Duration::from_secs(240);
const PLAN_EXPORT_DEADLINE: Duration = Duration::from_secs(20 * 60);
const EXPORT_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);
const ENGINE_VERSION: &str = "readany-pdf-v9-offline-pdf2zh2.9.0-babeldoc0.6.2";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEngineRequest {
    pub job_id: String,
    pub action: String,
    pub file_path: Option<String>,
    pub page: Option<u32>,
    pub target_lang: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub profile_id: Option<String>,
    pub use_exact_request_url: Option<bool>,
    pub force: Option<bool>,
    pub translation_context: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEngineInfo {
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEngineStartResponse {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEngineStatus {
    pub job_id: String,
    pub status: String,
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<PdfEngineProgress>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfEngineProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requests_started: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requests_completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    received_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    book_current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    book_total: Option<u64>,
}

impl PdfEngineProgress {
    fn validated(mut self) -> Self {
        self.stage = self.stage.filter(|s| {
            matches!(
                s.as_str(),
                "parse"
                    | "scan"
                    | "layout"
                    | "table"
                    | "paragraphs"
                    | "formulas"
                    | "baseline"
                    | "translate"
                    | "typeset"
                    | "fonts"
                    | "drawing"
                    | "subset"
                    | "save"
            )
        });
        if !matches!((self.current, self.total), (Some(c), Some(t)) if c <= t && t <= 1_000_000) {
            self.current = None;
            self.total = None;
        }
        self.requests_started = self.requests_started.filter(|n| *n <= 1_000_000);
        self.requests_completed = self
            .requests_completed
            .filter(|n| self.requests_started.is_some_and(|s| *n <= s));
        self.received_bytes = self.received_bytes.filter(|n| *n <= 1_000_000_000_000);
        if !matches!((self.book_current, self.book_total), (Some(c), Some(t)) if c <= t && t <= 1_000_000)
        {
            self.book_current = None;
            self.book_total = None;
        }
        self
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportPlan {
    total_pages: u64,
    cached_pages: u64,
    missing_pages: u64,
    non_text_pages: u64,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportDestination {
    destination_path: String,
    display_path: String,
    exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportSaveResult {
    destination_path: String,
    bytes: u64,
    sha256: String,
    warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct EnginePaths {
    engine_dir: PathBuf,
    jobs_dir: PathBuf,
    assets_dir: PathBuf,
    cache_dir: PathBuf,
    runtime_dir: PathBuf,
    resource_dir: PathBuf,
}

impl EnginePaths {
    fn from_app(app_local_data_dir: PathBuf, resource_dir: PathBuf) -> Self {
        let engine_namespace = mac_engine_namespace(&resource_dir);
        let engine_dir = app_local_data_dir.join("pdf-engine").join(engine_namespace);
        Self {
            jobs_dir: engine_dir.join("jobs"),
            assets_dir: engine_dir.join("assets"),
            cache_dir: engine_dir.join("pages"),
            runtime_dir: resource_dir.join("pdf-runtime"),
            resource_dir: resource_dir.join("pdf-engine"),
            engine_dir,
        }
    }

    fn ready_marker(&self) -> PathBuf {
        self.engine_dir.join("ready.json")
    }

    fn env_python(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            return self.engine_dir.join("env").join("bin").join("python");
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.engine_dir
                .join("env")
                .join("Scripts")
                .join("python.exe")
        }
    }

    fn runtime_python(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            self.runtime_dir.join("bin").join("python3")
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.runtime_dir.join("python.exe")
        }
    }

    fn requirements_lock(&self) -> PathBuf {
        #[cfg(target_os = "macos")]
        {
            self.resource_dir.join("requirements.macos-arm64.lock")
        }
        #[cfg(not(target_os = "macos"))]
        {
            self.resource_dir.join("requirements.lock")
        }
    }
}

fn mac_engine_namespace(resource_dir: &Path) -> String {
    #[cfg(target_os = "macos")]
    {
        let manifest = resource_dir.join("pdf-offline").join("manifest.json");
        let manifest_hash =
            sha256_file(&manifest).unwrap_or_else(|| "missing-manifest".to_string());
        // A packaged runtime is private to the app bundle.  Include its
        // resolved location in the environment namespace so moving the app
        // bundle cannot accidentally reuse an environment with stale
        // extension binaries or a stale dyld identity.
        let runtime = resource_dir.join("pdf-runtime");
        let runtime_identity = fs::canonicalize(&runtime).unwrap_or(runtime);
        let runtime_hash = sha256_bytes(path_to_json_string(&runtime_identity).as_bytes());
        return format!("v1-macos-arm64-{manifest_hash}-{runtime_hash}");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = resource_dir;
        "v1".to_string()
    }
}

#[derive(Debug, Clone)]
struct JobStatusData {
    status: String,
    phase: String,
    error: Option<String>,
    cached: Option<bool>,
    result_path: Option<PathBuf>,
    progress: Option<PdfEngineProgress>,
}

struct JobState {
    job_id: String,
    job_dir: PathBuf,
    cancelled: AtomicBool,
    status: Mutex<JobStatusData>,
    control: Mutex<Option<mpsc::Sender<ControlMessage>>>,
}

impl JobState {
    fn new(job_id: String, job_dir: PathBuf) -> Self {
        Self {
            job_id,
            job_dir,
            cancelled: AtomicBool::new(false),
            status: Mutex::new(JobStatusData {
                status: "running".to_string(),
                phase: "starting".to_string(),
                error: None,
                cached: None,
                result_path: None,
                progress: None,
            }),
            control: Mutex::new(None),
        }
    }

    fn request_cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(control) = self.control.lock() {
            if let Some(sender) = control.as_ref() {
                let _ = sender.send(ControlMessage::Cancel);
            }
        }
    }

    fn install_control(&self, sender: mpsc::Sender<ControlMessage>) {
        if let Ok(mut control) = self.control.lock() {
            *control = Some(sender.clone());
        }
        if self.cancelled.load(Ordering::Acquire) {
            let _ = sender.send(ControlMessage::Cancel);
        }
    }

    fn set_progress(&self, phase: String, progress: Option<PdfEngineProgress>) {
        if let Ok(mut status) = self.status.lock() {
            if status.status != "running" {
                return;
            }
            status.phase = phase.chars().take(128).collect();
            status.progress = progress.map(PdfEngineProgress::validated);
        }
    }

    fn finish(
        &self,
        status: &str,
        phase: &str,
        error: Option<String>,
        cached: Option<bool>,
        result_path: Option<PathBuf>,
    ) {
        if let Ok(mut current) = self.status.lock() {
            current.status = status.to_string();
            current.phase = phase.to_string();
            current.error = error;
            current.cached = cached;
            current.result_path = result_path;
        }
        if let Ok(mut control) = self.control.lock() {
            control.take();
        }
    }

    fn public_status(&self) -> PdfEngineStatus {
        let status = self.status.lock().expect("pdf job status poisoned");
        PdfEngineStatus {
            job_id: self.job_id.clone(),
            status: status.status.clone(),
            phase: status.phase.clone(),
            error: status.error.clone(),
            cached: status.cached,
            progress: status.progress.clone(),
        }
    }
}

enum ControlMessage {
    Cancel,
}

pub struct PdfEngineState {
    inner: Arc<PdfEngineInner>,
}

struct PdfEngineInner {
    paths: OnceLock<EnginePaths>,
    jobs: Mutex<HashMap<String, Arc<JobState>>>,
    active_job: Mutex<Option<String>>,
}

impl PdfEngineState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(PdfEngineInner {
                paths: OnceLock::new(),
                jobs: Mutex::new(HashMap::new()),
                active_job: Mutex::new(None),
            }),
        }
    }

    pub fn configure(
        &self,
        app_local_data_dir: PathBuf,
        resource_dir: PathBuf,
    ) -> Result<(), String> {
        let paths = EnginePaths::from_app(app_local_data_dir, resource_dir);
        create_engine_dirs(&paths)?;
        let _ = self.inner.paths.set(paths);
        Ok(())
    }

    /// Cancel active native workers and give their process-group guards a
    /// bounded opportunity to terminate and reap before Tauri tears down the
    /// application state.  The Drop implementation remains a final safety
    /// net for paths that do not receive a RunEvent::Exit callback.
    pub fn shutdown(&self) {
        let jobs = self
            .inner
            .jobs
            .lock()
            .map(|jobs| jobs.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for job in &jobs {
            job.request_cancel();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let running = jobs.iter().any(|job| {
                job.status
                    .lock()
                    .map(|status| status.status == "running")
                    .unwrap_or(false)
            });
            if !running {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Default for PdfEngineState {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for PdfEngineInner {
    fn drop(&mut self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                job.request_cancel();
            }
        }
    }
}

fn paths(state: &PdfEngineState) -> Result<EnginePaths, String> {
    state
        .inner
        .paths
        .get()
        .cloned()
        .ok_or_else(|| "pdf engine is not initialized".to_string())
}

pub fn configure_from_app(
    state: &PdfEngineState,
    app_local_data_dir: PathBuf,
    resource_dir: PathBuf,
) -> Result<(), String> {
    state.configure(app_local_data_dir, resource_dir)
}

#[tauri::command]
pub fn pdf_engine_info(state: State<'_, PdfEngineState>) -> PdfEngineInfo {
    let ready = paths(&state)
        .map(|paths| ready_marker_is_valid(&paths))
        .unwrap_or(false);
    PdfEngineInfo { ready }
}

#[tauri::command]
pub fn pdf_engine_start(
    request: PdfEngineRequest,
    state: State<'_, PdfEngineState>,
) -> Result<PdfEngineStartResponse, String> {
    let paths = paths(&state)?;
    validate_request(&request)?;

    let mut worker_request = request.clone();
    if matches!(
        request.action.as_str(),
        "translate" | "plan-export" | "export"
    ) {
        let input = request
            .file_path
            .as_deref()
            .ok_or_else(|| "PDF filePath is required".to_string())?;
        let canonical = validate_pdf_input(input)?;
        worker_request.file_path = Some(path_to_json_string(&canonical));
    }

    let job_id = Uuid::parse_str(&request.job_id)
        .map_err(|_| "jobId must be a UUID".to_string())?
        .to_string();
    let job_dir = create_job_dir(&paths)?;
    let job = Arc::new(JobState::new(job_id.clone(), job_dir));

    {
        let mut jobs = state
            .inner
            .jobs
            .lock()
            .map_err(|_| "pdf engine state unavailable".to_string())?;
        let mut active = state
            .inner
            .active_job
            .lock()
            .map_err(|_| "pdf engine state unavailable".to_string())?;
        if active.is_some() {
            remove_job_dir(&job.job_dir);
            return Err("pdf engine busy".to_string());
        }
        if jobs.contains_key(&job_id) {
            remove_job_dir(&job.job_dir);
            return Err("jobId is already in use".to_string());
        }
        if jobs.len() >= MAX_JOBS {
            let evict = jobs.iter().find_map(|(id, candidate)| {
                let current = candidate.status.lock().ok()?;
                (current.status != "running").then(|| id.clone())
            });
            if let Some(id) = evict {
                if let Some(old) = jobs.remove(&id) {
                    remove_job_dir(&old.job_dir);
                }
            } else {
                remove_job_dir(&job.job_dir);
                return Err("pdf engine job limit reached".to_string());
            }
        }
        jobs.insert(job_id.clone(), Arc::clone(&job));
        *active = Some(job_id.clone());
    }

    let weak_inner = Arc::downgrade(&state.inner);
    let thread_job = Arc::clone(&job);
    let thread_request = worker_request;
    if thread::Builder::new()
        .name("pdf-engine-worker".to_string())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run_job(
                    thread_job.clone(),
                    thread_request,
                    paths,
                    weak_inner.clone(),
                );
            }));
            if result.is_err() {
                thread_job.finish(
                    "error",
                    "error",
                    Some("pdf engine failed".to_string()),
                    None,
                    None,
                );
                finish_job(&weak_inner, &thread_job);
            }
        })
        .is_err()
    {
        job.finish(
            "error",
            "error",
            Some("unable to start pdf engine".to_string()),
            None,
            None,
        );
        finish_job(&Arc::downgrade(&state.inner), &job);
        return Err("unable to start pdf engine".to_string());
    }

    Ok(PdfEngineStartResponse { job_id })
}

#[tauri::command]
pub fn pdf_engine_status(
    job_id: String,
    state: State<'_, PdfEngineState>,
) -> Result<PdfEngineStatus, String> {
    let jobs = state
        .inner
        .jobs
        .lock()
        .map_err(|_| "pdf engine state unavailable".to_string())?;
    jobs.get(&job_id)
        .map(|job| job.public_status())
        .ok_or_else(|| "job not found".to_string())
}

#[tauri::command]
pub fn pdf_engine_cancel(job_id: String, state: State<'_, PdfEngineState>) -> Result<(), String> {
    let jobs = state
        .inner
        .jobs
        .lock()
        .map_err(|_| "pdf engine state unavailable".to_string())?;
    jobs.get(&job_id)
        .ok_or_else(|| "job not found".to_string())?
        .request_cancel();
    Ok(())
}

#[tauri::command]
pub fn pdf_engine_result(
    job_id: String,
    state: State<'_, PdfEngineState>,
) -> Result<String, String> {
    let paths = paths(&state)?;
    let job = {
        let jobs = state
            .inner
            .jobs
            .lock()
            .map_err(|_| "pdf engine state unavailable".to_string())?;
        jobs.get(&job_id)
            .cloned()
            .ok_or_else(|| "job not found".to_string())?
    };
    let result_path = {
        let status = job
            .status
            .lock()
            .map_err(|_| "pdf engine state unavailable".to_string())?;
        if status.status != "complete" {
            return Err("result is not ready".to_string());
        }
        status
            .result_path
            .clone()
            .ok_or_else(|| "job has no result".to_string())?
    };
    let safe_path = validate_result_path(&paths.cache_dir, &result_path)?;
    let bytes = fs::read(safe_path).map_err(|_| "unable to read pdf result".to_string())?;
    if bytes.len() as u64 > MAX_RESULT_BYTES || !has_pdf_magic(&bytes) {
        return Err("invalid pdf result".to_string());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn pdf_engine_plan_result(
    job_id: String,
    state: State<'_, PdfEngineState>,
) -> Result<PdfExportPlan, String> {
    let paths = paths(&state)?;
    let result_path = completed_job_result_path(&job_id, &state)?;
    let plan_root = paths.cache_dir.join("plans");
    let safe_path = validate_cache_file(&plan_root, &result_path, 64 * 1024, Some("json"))?;
    let contents =
        fs::read_to_string(safe_path).map_err(|_| "unable to read export plan".to_string())?;
    let plan: PdfExportPlan =
        serde_json::from_str(&contents).map_err(|_| "invalid export plan".to_string())?;
    if plan.total_pages == 0
        || plan.cached_pages + plan.missing_pages + plan.non_text_pages != plan.total_pages
    {
        return Err("invalid export plan".to_string());
    }
    Ok(plan)
}

#[tauri::command]
pub fn pdf_engine_validate_export_destination(
    source_path: String,
    destination_path: String,
    overwrite_approved: bool,
) -> Result<PdfExportDestination, String> {
    let source = validate_pdf_input(&source_path)?;
    validate_export_destination(&source, &destination_path, overwrite_approved)
}

#[tauri::command]
pub fn pdf_engine_save_export(
    job_id: String,
    source_path: String,
    destination_path: String,
    overwrite_approved: bool,
    state: State<'_, PdfEngineState>,
) -> Result<PdfExportSaveResult, String> {
    let paths = paths(&state)?;
    let source = validate_pdf_input(&source_path)?;
    let destination = validate_export_destination(&source, &destination_path, overwrite_approved)?;
    let result_path = completed_job_result_path(&job_id, &state)?;
    let export_root = paths.cache_dir.join("exports");
    let safe_result = validate_pdf_cache_file(&export_root, &result_path, MAX_EXPORT_BYTES)?;
    #[cfg(target_os = "macos")]
    {
        return save_export_macos(&safe_result, &source, &destination, overwrite_approved);
    }
    let final_path = PathBuf::from(&destination.destination_path);
    let parent = final_path
        .parent()
        .ok_or_else(|| "export destination is invalid".to_string())?;
    let file_name = final_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "export destination is invalid".to_string())?;
    let temporary = parent.join(format!(".{file_name}.{}.partial.pdf", Uuid::new_v4()));
    let copy_result = (|| -> Result<(u64, String), String> {
        let mut input =
            File::open(&safe_result).map_err(|_| "unable to read exported PDF".to_string())?;
        let mut output =
            File::create(&temporary).map_err(|_| "unable to create export file".to_string())?;
        let bytes = io::copy(&mut input, &mut output)
            .map_err(|_| "unable to write export file".to_string())?;
        output
            .sync_all()
            .map_err(|_| "unable to flush export file".to_string())?;
        if bytes == 0 || bytes > MAX_EXPORT_BYTES {
            return Err("invalid exported PDF size".to_string());
        }
        let hash =
            sha256_file(&temporary).ok_or_else(|| "unable to verify export file".to_string())?;
        validate_pdf_cache_file(parent, &temporary, MAX_EXPORT_BYTES)?;
        Ok((bytes, hash))
    })();
    let (bytes, sha256) = match copy_result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    if let Err(error) = atomic_publish(&temporary, &final_path, destination.exists) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(PdfExportSaveResult {
        destination_path: path_to_json_string(&final_path),
        bytes,
        sha256,
        warnings: Vec::new(),
    })
}

fn completed_job_result_path(job_id: &str, state: &PdfEngineState) -> Result<PathBuf, String> {
    let jobs = state
        .inner
        .jobs
        .lock()
        .map_err(|_| "pdf engine state unavailable".to_string())?;
    let job = jobs
        .get(job_id)
        .ok_or_else(|| "job not found".to_string())?;
    let status = job
        .status
        .lock()
        .map_err(|_| "pdf engine state unavailable".to_string())?;
    if status.status != "complete" {
        return Err("result is not ready".to_string());
    }
    status
        .result_path
        .clone()
        .ok_or_else(|| "job has no result".to_string())
}

fn create_engine_dirs(paths: &EnginePaths) -> Result<(), String> {
    for directory in [
        &paths.engine_dir,
        &paths.jobs_dir,
        &paths.assets_dir,
        &paths.cache_dir,
    ] {
        fs::create_dir_all(directory)
            .map_err(|_| "unable to initialize pdf engine storage".to_string())?;
    }
    if let Ok(entries) = fs::read_dir(&paths.jobs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                remove_job_dir(&path);
            }
        }
    }
    Ok(())
}

fn ready_marker_is_valid(paths: &EnginePaths) -> bool {
    let marker = paths.ready_marker();
    if !fs::metadata(&marker)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
        || !fs::metadata(paths.env_python())
            .map(|metadata| metadata.is_file())
            .unwrap_or(false)
    {
        return false;
    }
    let expected_lock = match sha256_file(&paths.requirements_lock()) {
        Some(hash) => hash,
        None => return false,
    };
    let marker_value: serde_json::Value = match fs::read_to_string(marker)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
    {
        Some(value) => value,
        None => return false,
    };
    let platform_valid = {
        #[cfg(target_os = "macos")]
        {
            marker_value
                .get("platform")
                .and_then(serde_json::Value::as_str)
                == Some("macos-arm64")
        }
        #[cfg(not(target_os = "macos"))]
        {
            true
        }
    };
    platform_valid
        && marker_value
            .get("version")
            .and_then(serde_json::Value::as_str)
            == Some(ENGINE_VERSION)
        && marker_value.get("lock").and_then(serde_json::Value::as_str)
            == Some(expected_lock.as_str())
}

fn sha256_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Some(format!("{:x}", digest.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn create_job_dir(paths: &EnginePaths) -> Result<PathBuf, String> {
    for _ in 0..8 {
        let directory = paths.jobs_dir.join(Uuid::new_v4().to_string());
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(_) => break,
        }
    }
    Err("unable to allocate pdf engine job".to_string())
}

fn remove_job_dir(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

fn validate_request(request: &PdfEngineRequest) -> Result<(), String> {
    Uuid::parse_str(&request.job_id).map_err(|_| "jobId must be a UUID".to_string())?;
    validate_translation_context(request.translation_context.as_deref())?;
    match request.action.as_str() {
        "setup" => Ok(()),
        "translate" | "plan-export" | "export" => {
            if request.file_path.is_none() {
                return Err("PDF filePath is required".to_string());
            }
            if request.action == "translate" && request.page.unwrap_or(0) == 0 {
                return Err("page must be a positive 1-based number".to_string());
            }
            if request
                .target_lang
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
            {
                return Err("targetLang is required".to_string());
            }
            Ok(())
        }
        _ => Err("unsupported pdf engine action".to_string()),
    }
}

fn validate_translation_context(value: Option<&str>) -> Result<(), String> {
    if value.is_some_and(|context| context.len() > MAX_TRANSLATION_CONTEXT_BYTES) {
        return Err("translationContext is too large".to_string());
    }
    Ok(())
}

fn validate_pdf_input(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("PDF filePath is required".to_string());
    }
    reject_unsafe_windows_path(raw)?;
    let path = PathBuf::from(raw);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "PDF file is unavailable".to_string())?;
    if !metadata.file_type().is_file() {
        return Err("PDF file is not a regular file".to_string());
    }
    reject_reparse_file(&path, &metadata)?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pdf"))
        != Some(true)
    {
        return Err("PDF file must use the .pdf extension".to_string());
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err("PDF file is too large".to_string());
    }
    let canonical = fs::canonicalize(&path).map_err(|_| "PDF file is unavailable".to_string())?;
    let canonical_metadata =
        fs::metadata(&canonical).map_err(|_| "PDF file is unavailable".to_string())?;
    if !canonical_metadata.is_file() || canonical_metadata.len() > MAX_INPUT_BYTES {
        return Err("PDF file is not a valid regular file".to_string());
    }
    let mut file = File::open(&canonical).map_err(|_| "PDF file is unavailable".to_string())?;
    let mut header = [0_u8; 1024];
    let read = file
        .read(&mut header)
        .map_err(|_| "PDF file is unavailable".to_string())?;
    if !has_pdf_magic(&header[..read]) {
        return Err("PDF signature is missing".to_string());
    }
    Ok(canonical)
}

fn reject_unsafe_windows_path(raw: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let lower = raw.to_ascii_lowercase();
        if lower.starts_with("\\\\")
            || lower.starts_with("//")
            || lower.starts_with("\\\\?\\")
            || lower.starts_with("\\\\.\\")
        {
            return Err("UNC and device paths are not supported".to_string());
        }
    }
    Ok(())
}

fn reject_reparse_file(path: &Path, metadata: &fs::Metadata) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("reparse-point PDF paths are not supported".to_string());
        }
        let mut current = path.to_path_buf();
        while let Some(parent) = current.parent() {
            if let Ok(parent_metadata) = fs::symlink_metadata(&current) {
                if parent_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err("reparse-point PDF paths are not supported".to_string());
                }
            }
            if parent == current {
                break;
            }
            current = parent.to_path_buf();
        }
    }
    let _ = (path, metadata);
    Ok(())
}

fn has_pdf_magic(bytes: &[u8]) -> bool {
    bytes.windows(4).any(|window| window == b"%PDF")
}

fn path_to_json_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerInput {
    #[serde(flatten)]
    request: PdfEngineRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    translation_context_digest: Option<String>,
    engine_dir: String,
    job_dir: String,
    assets_dir: String,
    cache_dir: String,
    runtime_dir: String,
    resource_dir: String,
}

fn worker_request_for_action(request: &PdfEngineRequest) -> PdfEngineRequest {
    let mut worker_request = request.clone();
    if worker_request.action == "setup" {
        worker_request.base_url = None;
        worker_request.api_key = None;
        worker_request.model = None;
        worker_request.profile_id = None;
        worker_request.target_lang = None;
        worker_request.file_path = None;
        worker_request.page = None;
        worker_request.translation_context = None;
    }
    worker_request
}

#[derive(Debug, Deserialize)]
struct WorkerMessage {
    #[serde(rename = "type")]
    message_type: String,
    phase: Option<String>,
    progress: Option<PdfEngineProgress>,
    path: Option<String>,
    cached: Option<bool>,
    #[allow(dead_code)]
    code: Option<String>,
    #[allow(dead_code)]
    message: Option<String>,
}

#[cfg(any(windows, target_os = "macos"))]
fn run_job(
    job: Arc<JobState>,
    request: PdfEngineRequest,
    paths: EnginePaths,
    weak_inner: Weak<PdfEngineInner>,
) {
    if job.cancelled.load(Ordering::Acquire) {
        job.finish("cancelled", "cancelled", None, None, None);
        finish_job(&weak_inner, &job);
        remove_job_dir(&job.job_dir);
        return;
    }

    let worker_request = worker_request_for_action(&request);
    let worker_input = WorkerInput {
        translation_context_digest: worker_request
            .translation_context
            .as_deref()
            .map(|context| sha256_bytes(context.as_bytes())),
        request: worker_request,
        engine_dir: path_to_json_string(&paths.engine_dir),
        job_dir: path_to_json_string(&job.job_dir),
        assets_dir: path_to_json_string(&paths.assets_dir),
        cache_dir: path_to_json_string(&paths.cache_dir),
        runtime_dir: path_to_json_string(&paths.runtime_dir),
        resource_dir: path_to_json_string(&paths.resource_dir),
    };
    let input = match serde_json::to_vec(&worker_input) {
        Ok(input) if input.len() < 128 * 1024 => input,
        _ => {
            job.finish(
                "error",
                "error",
                Some("invalid pdf engine request".to_string()),
                None,
                None,
            );
            finish_job(&weak_inner, &job);
            remove_job_dir(&job.job_dir);
            return;
        }
    };

    let (control_tx, control_rx) = mpsc::channel();
    job.install_control(control_tx);
    let deadline = match request.action.as_str() {
        "setup" => SETUP_DEADLINE,
        "plan-export" => PLAN_EXPORT_DEADLINE,
        "export" => EXPORT_DEADLINE,
        _ => TRANSLATE_DEADLINE,
    };
    let mut process = match spawn_worker(&request, &paths) {
        Ok(process) => process,
        Err(error) => {
            let status = if job.cancelled.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "error"
            };
            job.finish(
                status,
                status,
                (status == "error").then_some(error),
                None,
                None,
            );
            finish_job(&weak_inner, &job);
            remove_job_dir(&job.job_dir);
            return;
        }
    };

    // The request can be cancelled while CreateProcess is assigning the
    // suspended child to its Job Object.  Re-check before sending stdin so a
    // pre-start cancellation remains a tombstone and never reaches Python.
    if job.cancelled.load(Ordering::Acquire) {
        process.terminate();
        let _ = process.wait();
        job.finish("cancelled", "cancelled", None, None, None);
        finish_job(&weak_inner, &job);
        remove_job_dir(&job.job_dir);
        return;
    }

    if let Some(mut stdin) = process.child.stdin.take() {
        if stdin.write_all(&input).is_err() || stdin.write_all(b"\n").is_err() {
            process.terminate();
            let _ = process.wait();
            job.finish(
                "error",
                "error",
                Some("unable to send pdf engine request".to_string()),
                None,
                None,
            );
            finish_job(&weak_inner, &job);
            remove_job_dir(&job.job_dir);
            return;
        }
    } else {
        process.terminate();
        let _ = process.wait();
        job.finish(
            "error",
            "error",
            Some("unable to send pdf engine request".to_string()),
            None,
            None,
        );
        finish_job(&weak_inner, &job);
        remove_job_dir(&job.job_dir);
        return;
    }

    let stdout = process.child.stdout.take();
    let stderr = process.child.stderr.take();
    let (event_tx, event_rx) = mpsc::channel();
    let stdout_thread =
        stdout.map(|stdout| thread::spawn(move || read_worker_stdout(stdout, event_tx)));
    let stderr_thread = stderr.map(|mut stderr| {
        thread::spawn(move || {
            let mut sink = io::sink();
            let _ = io::copy(&mut stderr, &mut sink);
        })
    });

    let started = Instant::now();
    let mut completion: Option<(Option<String>, Option<bool>)> = None;
    let mut worker_error: Option<&'static str> = None;
    let mut protocol_error = false;
    let mut timed_out = false;
    let mut cancelled = false;
    let mut exit_status = None;

    loop {
        if job.cancelled.load(Ordering::Acquire) {
            cancelled = true;
            process.terminate();
        } else if started.elapsed() >= deadline {
            timed_out = true;
            process.terminate();
        }

        match event_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(WorkerEvent::Progress(phase, progress)) => job.set_progress(phase, progress),
            Ok(WorkerEvent::Complete { path, cached }) => completion = Some((path, cached)),
            Ok(WorkerEvent::Error(code)) => {
                worker_error = Some(safe_worker_error(&code));
                process.terminate();
            }
            Ok(WorkerEvent::ProtocolError) => {
                protocol_error = true;
                process.terminate();
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if let Ok(status) = process.try_wait() {
            if status.is_some() {
                exit_status = status;
                while let Ok(event) = event_rx.try_recv() {
                    match event {
                        WorkerEvent::Progress(phase, progress) => job.set_progress(phase, progress),
                        WorkerEvent::Complete { path, cached } => completion = Some((path, cached)),
                        WorkerEvent::Error(code) => {
                            worker_error = Some(safe_worker_error(&code));
                        }
                        WorkerEvent::ProtocolError => protocol_error = true,
                    }
                }
                break;
            }
        } else {
            protocol_error = true;
            process.terminate();
        }
    }

    if exit_status.is_none() {
        exit_status = process.wait().ok();
    }
    process.terminate();
    if let Some(thread) = stdout_thread {
        let _ = thread.join();
    }
    if let Some(thread) = stderr_thread {
        let _ = thread.join();
    }
    // A short-lived worker can exit before the stdout reader thread gets
    // scheduled.  Joining the reader first and draining once more prevents a
    // valid final `complete` event from being lost at that boundary.
    while let Ok(event) = event_rx.try_recv() {
        match event {
            WorkerEvent::Progress(phase, progress) => job.set_progress(phase, progress),
            WorkerEvent::Complete {
                path,
                cached: event_cached,
            } => {
                completion = Some((path, event_cached));
            }
            WorkerEvent::Error(code) => worker_error = Some(safe_worker_error(&code)),
            WorkerEvent::ProtocolError => protocol_error = true,
        }
    }

    if job.cancelled.load(Ordering::Acquire) {
        cancelled = true;
    }
    let succeeded = exit_status.map(|status| status.success()).unwrap_or(false);
    let mut result_path = None;
    let mut cached = None;
    let (status, phase, error) = if cancelled {
        ("cancelled", "cancelled", None)
    } else if timed_out {
        (
            "error",
            "error",
            Some("pdf engine deadline exceeded".to_string()),
        )
    } else if protocol_error {
        (
            "error",
            "error",
            Some("pdf engine protocol error".to_string()),
        )
    } else if let Some(worker_error) = worker_error {
        ("error", "error", Some(worker_error.to_string()))
    } else if !succeeded || completion.is_none() {
        ("error", "error", Some("pdf engine failed".to_string()))
    } else {
        let (path, event_cached) = completion.expect("completion checked above");
        cached = event_cached;
        if matches!(request.action.as_str(), "translate" | "export") {
            match path.and_then(|path| {
                if request.action == "export" {
                    validate_pdf_cache_file(
                        &paths.cache_dir.join("exports"),
                        Path::new(&path),
                        MAX_EXPORT_BYTES,
                    )
                    .ok()
                } else {
                    validate_result_path(&paths.cache_dir, Path::new(&path)).ok()
                }
            }) {
                Some(path) => {
                    result_path = Some(path);
                    ("complete", "complete", None)
                }
                None => ("error", "error", Some("invalid pdf result".to_string())),
            }
        } else if request.action == "plan-export" {
            match path.and_then(|path| {
                validate_cache_file(
                    &paths.cache_dir.join("plans"),
                    Path::new(&path),
                    64 * 1024,
                    Some("json"),
                )
                .ok()
            }) {
                Some(path) => {
                    result_path = Some(path);
                    ("complete", "complete", None)
                }
                None => ("error", "error", Some("invalid export plan".to_string())),
            }
        } else {
            ("complete", "complete", None)
        }
    };

    job.finish(status, phase, error, cached, result_path);
    finish_job(&weak_inner, &job);
    remove_job_dir(&job.job_dir);
    let _ = control_rx;
}

#[cfg(not(any(windows, target_os = "macos")))]
fn run_job(
    job: Arc<JobState>,
    _request: PdfEngineRequest,
    _paths: EnginePaths,
    weak_inner: Weak<PdfEngineInner>,
) {
    let status = if job.cancelled.load(Ordering::Acquire) {
        "cancelled"
    } else {
        "error"
    };
    let error = (status == "error")
        .then_some("pdf engine is only supported by the Windows or macOS installer".to_string());
    job.finish(status, status, error, None, None);
    finish_job(&weak_inner, &job);
    remove_job_dir(&job.job_dir);
}

fn finish_job(weak_inner: &Weak<PdfEngineInner>, job: &JobState) {
    if let Some(inner) = weak_inner.upgrade() {
        if let Ok(mut active) = inner.active_job.lock() {
            if active.as_deref() == Some(&job.job_id) {
                *active = None;
            }
        }
    }
}

fn validate_result_path(cache_dir: &Path, result_path: &Path) -> Result<PathBuf, String> {
    validate_pdf_cache_file(cache_dir, result_path, MAX_RESULT_BYTES)
}

fn validate_cache_file(
    root: &Path,
    candidate: &Path,
    max_bytes: u64,
    extension: Option<&str>,
) -> Result<PathBuf, String> {
    let cache_root = fs::canonicalize(root).map_err(|_| "invalid pdf result".to_string())?;
    let candidate = fs::canonicalize(candidate).map_err(|_| "invalid pdf result".to_string())?;
    if !path_is_within(&candidate, &cache_root) {
        return Err("invalid pdf result".to_string());
    }
    let metadata = fs::metadata(&candidate).map_err(|_| "invalid pdf result".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return Err("invalid pdf result".to_string());
    }
    if extension.is_some_and(|expected| {
        candidate
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|actual| !actual.eq_ignore_ascii_case(expected))
    }) {
        return Err("invalid pdf result".to_string());
    }
    Ok(candidate)
}

fn validate_pdf_cache_file(
    root: &Path,
    candidate: &Path,
    max_bytes: u64,
) -> Result<PathBuf, String> {
    let candidate = validate_cache_file(root, candidate, max_bytes, Some("pdf"))?;
    let mut file = File::open(&candidate).map_err(|_| "invalid pdf result".to_string())?;
    let mut header = [0_u8; 1024];
    let read = file
        .read(&mut header)
        .map_err(|_| "invalid pdf result".to_string())?;
    if !has_pdf_magic(&header[..read]) {
        return Err("invalid pdf result".to_string());
    }
    Ok(candidate)
}

fn validate_export_destination(
    source: &Path,
    raw_destination: &str,
    overwrite_approved: bool,
) -> Result<PdfExportDestination, String> {
    if raw_destination.trim().is_empty() {
        return Err("export destination is required".to_string());
    }
    reject_unsafe_windows_path(raw_destination)?;
    let destination = PathBuf::from(raw_destination);
    if destination
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("pdf"))
    {
        return Err("export destination must use the .pdf extension".to_string());
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "export destination is invalid".to_string())?;
    #[cfg(target_os = "macos")]
    reject_macos_symlink_ancestors(parent)?;
    let parent_metadata = fs::symlink_metadata(parent)
        .map_err(|_| "export destination directory is unavailable".to_string())?;
    if !parent_metadata.is_dir() {
        return Err("export destination directory is unavailable".to_string());
    }
    reject_reparse_file(parent, &parent_metadata)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| "export destination directory is unavailable".to_string())?;
    let file_name = destination
        .file_name()
        .ok_or_else(|| "export destination is invalid".to_string())?;
    let normalized = canonical_parent.join(file_name);
    if path_eq_case_insensitive(source, &normalized) {
        return Err("export destination cannot overwrite the source PDF".to_string());
    }
    let exists = normalized.exists();
    if exists {
        let metadata = fs::symlink_metadata(&normalized)
            .map_err(|_| "export destination is unavailable".to_string())?;
        if !metadata.is_file() {
            return Err("export destination is not a regular file".to_string());
        }
        reject_reparse_file(&normalized, &metadata)?;
        if !overwrite_approved {
            return Err("export destination already exists".to_string());
        }
    }
    let display_path = path_to_json_string(&normalized);
    Ok(PdfExportDestination {
        destination_path: display_path.clone(),
        display_path,
        exists,
    })
}

fn path_eq_case_insensitive(left: &Path, right: &Path) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        path_to_json_string(left).eq_ignore_ascii_case(&path_to_json_string(right))
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        left == right
    }
}

#[cfg(target_os = "macos")]
fn reject_macos_symlink_ancestors(path: &Path) -> Result<(), String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "export destination directory is unavailable".to_string())?
            .join(path)
    };
    let mut current = PathBuf::new();
    for component in absolute.components() {
        current.push(component);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| "export destination directory is unavailable".to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("export destination cannot use symlink directories".to_string());
        }
        if !metadata.is_dir() {
            return Err("export destination directory is unavailable".to_string());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn renameatx_np(
        from_dir_fd: libc::c_int,
        from: *const libc::c_char,
        to_dir_fd: libc::c_int,
        to: *const libc::c_char,
        flags: libc::c_uint,
    ) -> libc::c_int;
}

#[cfg(target_os = "macos")]
fn macos_name(name: &std::ffi::OsStr) -> Result<std::ffi::CString, String> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes())
        .map_err(|_| "export destination contains an invalid NUL byte".to_string())
}

#[cfg(target_os = "macos")]
fn open_macos_directory(path: &Path) -> Result<File, String> {
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|_| "export destination directory is unavailable".to_string())?
            .join(path)
    };
    let mut directory =
        File::open("/").map_err(|_| "export destination directory is unavailable".to_string())?;
    for component in absolute.components() {
        let std::path::Component::Normal(component) = component else {
            continue;
        };
        let name = macos_name(component)?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err("export destination directory is unavailable".to_string());
        }
        // SAFETY: openat returned a new owned directory descriptor.  The
        // previous component remains open until this assignment, so every
        // lookup is relative to a stable, already-validated directory fd.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn macos_unlinkat(dir_fd: libc::c_int, name: &std::ffi::CString) {
    unsafe {
        let _ = libc::unlinkat(dir_fd, name.as_ptr(), 0);
    }
}

#[cfg(target_os = "macos")]
fn macos_statat(
    dir_fd: libc::c_int,
    name: &std::ffi::CString,
) -> Result<Option<libc::stat>, String> {
    let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
    let result =
        unsafe { libc::fstatat(dir_fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) };
    if result == 0 {
        return Ok(Some(stat));
    }
    if io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
        Ok(None)
    } else {
        Err("unable to inspect export destination".to_string())
    }
}

#[cfg(target_os = "macos")]
fn macos_regular_stat(stat: &libc::stat) -> bool {
    (stat.st_mode & libc::S_IFMT) == libc::S_IFREG
}

#[cfg(target_os = "macos")]
fn macos_copy_and_hash(input: &Path, output: &mut File) -> Result<(u64, String), String> {
    use sha2::{Digest, Sha256};
    let mut input = File::open(input).map_err(|_| "unable to read exported PDF".to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    let mut bytes = 0_u64;
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|_| "unable to read exported PDF".to_string())?;
        if read == 0 {
            break;
        }
        bytes = bytes
            .checked_add(read as u64)
            .ok_or_else(|| "invalid exported PDF size".to_string())?;
        if bytes > MAX_EXPORT_BYTES {
            return Err("invalid exported PDF size".to_string());
        }
        output
            .write_all(&buffer[..read])
            .map_err(|_| "unable to write export file".to_string())?;
        digest.update(&buffer[..read]);
    }
    if bytes == 0 {
        return Err("invalid exported PDF size".to_string());
    }
    Ok((bytes, format!("{:x}", digest.finalize())))
}

#[cfg(target_os = "macos")]
fn save_export_macos(
    safe_result: &Path,
    source: &Path,
    destination: &PdfExportDestination,
    overwrite_approved: bool,
) -> Result<PdfExportSaveResult, String> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let final_path = PathBuf::from(&destination.destination_path);
    let parent = final_path
        .parent()
        .ok_or_else(|| "export destination is invalid".to_string())?;
    // The destination was canonicalized by validate_export_destination.  Do
    // the check again here immediately before opening the directory fd so a
    // symlink replacement cannot turn the operation into a path traversal.
    reject_macos_symlink_ancestors(parent)?;
    let directory = open_macos_directory(parent)?;
    let dir_fd = directory.as_raw_fd();
    let destination_name = macos_name(
        final_path
            .file_name()
            .ok_or_else(|| "export destination is invalid".to_string())?,
    )?;
    let temporary_text = format!(
        ".{}.{}.partial.pdf",
        destination_name.to_string_lossy(),
        Uuid::new_v4()
    );
    let temporary_name = std::ffi::CString::new(temporary_text)
        .map_err(|_| "export destination is invalid".to_string())?;
    let result = (|| -> Result<(u64, String), String> {
        let fd = unsafe {
            libc::openat(
                dir_fd,
                temporary_name.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("unable to create export file".to_string());
        }
        // SAFETY: openat returned the unique owned descriptor above.
        let mut output = unsafe { File::from_raw_fd(fd) };
        let copied = macos_copy_and_hash(safe_result, &mut output)?;
        output
            .sync_all()
            .map_err(|_| "unable to flush export file".to_string())?;
        drop(output);

        let source_metadata =
            fs::metadata(source).map_err(|_| "source PDF is unavailable".to_string())?;
        let existing = macos_statat(dir_fd, &destination_name)?;
        if let Some(stat) = existing {
            if !macos_regular_stat(&stat) {
                return Err("export destination is not a regular file".to_string());
            }
            if stat.st_dev as u64 == source_metadata.dev() && stat.st_ino == source_metadata.ino() {
                return Err("export destination cannot overwrite the source PDF".to_string());
            }
            if !overwrite_approved {
                return Err("export destination already exists".to_string());
            }
        }

        let rename_result = if overwrite_approved {
            unsafe {
                libc::renameat(
                    dir_fd,
                    temporary_name.as_ptr(),
                    dir_fd,
                    destination_name.as_ptr(),
                )
            }
        } else {
            // RENAME_EXCL is the macOS no-replace variant.  The destination
            // is still checked above for a useful error and this operation is
            // the race-safe final guard.
            const RENAME_EXCL: libc::c_uint = 0x0000_0004;
            unsafe {
                renameatx_np(
                    dir_fd,
                    temporary_name.as_ptr(),
                    dir_fd,
                    destination_name.as_ptr(),
                    RENAME_EXCL,
                )
            }
        };
        if rename_result != 0 {
            return Err("unable to atomically publish exported PDF".to_string());
        }
        unsafe {
            if libc::fsync(dir_fd) != 0 {
                return Err("unable to flush export directory".to_string());
            }
        }
        Ok(copied)
    })();
    if result.is_err() {
        macos_unlinkat(dir_fd, &temporary_name);
    }
    let (bytes, sha256) = result?;
    Ok(PdfExportSaveResult {
        destination_path: path_to_json_string(&final_path),
        bytes,
        sha256,
        warnings: Vec::new(),
    })
}

#[cfg(windows)]
fn atomic_publish(temporary: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
        return Err("unable to atomically publish exported PDF".to_string());
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_publish(temporary: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    if replace {
        return Err("atomic replacement is unavailable on this platform".to_string());
    }
    fs::rename(temporary, destination)
        .map_err(|_| "unable to atomically publish exported PDF".to_string())
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    #[cfg(windows)]
    {
        let path = path_to_json_string(path).to_ascii_lowercase();
        let root = path_to_json_string(root).to_ascii_lowercase();
        return path == root || path.starts_with(&(root + "\\"));
    }
    #[cfg(not(windows))]
    {
        path == root || path.starts_with(root)
    }
}

enum WorkerEvent {
    Progress(String, Option<PdfEngineProgress>),
    Complete {
        path: Option<String>,
        cached: Option<bool>,
    },
    Error(String),
    ProtocolError,
}

fn safe_worker_error(code: &str) -> &'static str {
    match code {
        "endpoint" => "AI endpoint is invalid",
        "install" => "离线引擎初始化失败，请检查磁盘空间或重新安装完整版",
        "assets" => "离线资源缺失、损坏或运行库校验失败，请重新安装完整版；不会自动下载",
        "provider" => "AI provider request failed; the page was not cached",
        "provider-auth" => "AI 接口鉴权失败（401/403），请检查 Key 和模型权限；本页未缓存",
        "provider-rate" => "AI 接口限流或额度不足（429），请稍后重试或检查额度；本页未缓存",
        "provider-endpoint" => "AI 接口地址或模型不存在（404），请检查设置；本页未缓存",
        "provider-request" => "AI 接口拒绝请求，请检查模型及接口兼容性；本页未缓存",
        "provider-server" => "AI 服务端异常（5xx），请稍后重试；本页未缓存",
        "provider-timeout" => "AI 接口等待响应超时，请重试或更换模型；本页未缓存",
        "provider-network" => "无法连接 AI 接口，请检查网络、代理和证书；本页未缓存",
        "provider-response" => "AI 返回内容为空、不完整或格式无效，请重试或更换模型；本页未缓存",
        "context" => "翻译上下文格式无效或过大；本页未缓存",
        "encrypted" => "The PDF is encrypted",
        "page" => "The requested PDF page is invalid",
        "no-text" => "The PDF page has no extractable text",
        "translation" => "PDF 段落翻译或排版校验失败（不一定是网络问题）；本页未缓存，请重试",
        "output" => "The translated PDF failed validation",
        "action" => "Unsupported PDF engine action",
        _ => "PDF engine worker failed",
    }
}

fn read_worker_stdout(stdout: impl Read + Send + 'static, sender: mpsc::Sender<WorkerEvent>) {
    let mut reader = BufReader::new(stdout);
    loop {
        let mut line = Vec::new();
        let read = read_bounded_line(&mut reader, &mut line);
        match read {
            Ok(0) => break,
            Ok(_) => match serde_json::from_slice::<WorkerMessage>(&line) {
                Ok(message) => {
                    let event = match message.message_type.as_str() {
                        "progress" => WorkerEvent::Progress(
                            message.phase.unwrap_or_else(|| "working".to_string()),
                            message.progress,
                        ),
                        "complete" => WorkerEvent::Complete {
                            path: message.path,
                            cached: message.cached,
                        },
                        "error" => WorkerEvent::Error(message.code.unwrap_or_default()),
                        _ => WorkerEvent::ProtocolError,
                    };
                    if sender.send(event).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = sender.send(WorkerEvent::ProtocolError);
                    break;
                }
            },
            Err(_) => {
                let _ = sender.send(WorkerEvent::ProtocolError);
                break;
            }
        }
    }
}

fn read_bounded_line(reader: &mut impl BufRead, output: &mut Vec<u8>) -> io::Result<usize> {
    let mut limited = reader.take((MAX_LINE_BYTES + 1) as u64);
    let count = limited.read_until(b'\n', output)?;
    if count > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "worker line too long",
        ));
    }
    if output.last() == Some(&b'\n') {
        output.pop();
    }
    if output.last() == Some(&b'\r') {
        output.pop();
    }
    Ok(count)
}

#[cfg(windows)]
struct RunningProcess {
    child: std::process::Child,
    job: WindowsJob,
}

#[cfg(target_os = "macos")]
struct RunningProcess {
    child: std::process::Child,
    job: MacProcessGroup,
}

#[cfg(not(any(windows, target_os = "macos")))]
struct RunningProcess;

#[cfg(windows)]
impl RunningProcess {
    fn terminate(&mut self) {
        self.job.terminate();
    }

    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.child.wait()
    }
}

#[cfg(target_os = "macos")]
impl RunningProcess {
    fn terminate(&mut self) {
        self.job.terminate();
    }

    fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        if self.job.leader_exited()? {
            self.job.terminate();
            return self.job.wait(&mut self.child).map(Some);
        }
        Ok(None)
    }

    fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.job.wait(&mut self.child)
    }
}

#[cfg(target_os = "macos")]
impl Drop for RunningProcess {
    fn drop(&mut self) {
        let _ = self.wait();
    }
}

#[cfg(windows)]
fn spawn_worker(request: &PdfEngineRequest, paths: &EnginePaths) -> Result<RunningProcess, String> {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let executable = if request.action == "setup" {
        paths.runtime_python()
    } else {
        paths.env_python()
    };
    let worker = paths.resource_dir.join("worker.py");
    if !executable.is_file() || !worker.is_file() {
        return Err("pdf engine resources are unavailable".to_string());
    }
    let job = WindowsJob::new().map_err(|_| "unable to create pdf engine job".to_string())?;
    let mut command = Command::new(executable);
    command
        .arg("-I")
        .arg("-B")
        .arg(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|_| "unable to start pdf engine".to_string())?;
    let process_handle = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    if job.assign(process_handle).is_err() {
        // The process is still suspended and was not admitted to the Job
        // Object, so closing the job handle cannot terminate it.
        let _ = child.kill();
        job.terminate();
        let _ = child.wait();
        return Err("unable to isolate pdf engine".to_string());
    }
    if unsafe { NtResumeProcess(process_handle) } != 0 {
        let _ = child.kill();
        job.terminate();
        let _ = child.wait();
        return Err("unable to resume pdf engine".to_string());
    }
    Ok(RunningProcess { child, job })
}

#[cfg(target_os = "macos")]
fn spawn_worker(request: &PdfEngineRequest, paths: &EnginePaths) -> Result<RunningProcess, String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let executable = if request.action == "setup" {
        paths.runtime_python()
    } else {
        paths.env_python()
    };
    let worker = paths.resource_dir.join("worker.py");
    if !executable.is_file() || !worker.is_file() {
        return Err("pdf engine resources are unavailable".to_string());
    }
    let mut command = Command::new(executable);
    command
        .arg("-I")
        .arg("-B")
        .arg(worker)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A dedicated process group makes cancellation safe even when the
        // worker has spawned uv, model helpers, or other descendants.
        .process_group(0)
        // The Python watcher is only inherited by this primary worker.  It
        // removes the variable before it launches any descendants.
        .env("READANY_PDF_PARENT_PID", std::process::id().to_string());
    let child = command
        .spawn()
        .map_err(|_| "unable to start pdf engine".to_string())?;
    let pid = child.id() as libc::pid_t;
    let job = match MacProcessGroup::new(pid) {
        Ok(job) => job,
        Err(()) => {
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err("unable to isolate pdf engine".to_string());
        }
    };
    Ok(RunningProcess { child, job })
}

#[cfg(not(any(windows, target_os = "macos")))]
fn spawn_worker(
    _request: &PdfEngineRequest,
    _paths: &EnginePaths,
) -> Result<RunningProcess, String> {
    Err("pdf engine is only supported by the Windows or macOS installer".to_string())
}

#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x00000004;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsJob {
    fn new() -> Result<Self, ()> {
        use std::mem::size_of;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut limits as *mut _ as *mut _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(());
        }
        Ok(Self { handle })
    }

    fn assign(&self, process: windows_sys::Win32::Foundation::HANDLE) -> Result<(), ()> {
        let result = unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.handle, process)
        };
        if result == 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn terminate(&self) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process_handle: windows_sys::Win32::Foundation::HANDLE) -> i32;
}

#[cfg(target_os = "macos")]
struct MacProcessGroup {
    pid: libc::pid_t,
    pgid: libc::pid_t,
    term_sent: bool,
    kill_sent: bool,
    term_at: Option<Instant>,
}

#[cfg(target_os = "macos")]
impl MacProcessGroup {
    const TERM_GRACE: Duration = Duration::from_millis(250);

    fn new(pid: libc::pid_t) -> Result<Self, ()> {
        if pid <= 1 {
            return Err(());
        }
        let pgid = unsafe { libc::getpgid(pid) };
        if pgid != pid {
            return Err(());
        }
        Ok(Self {
            pid,
            pgid,
            term_sent: false,
            kill_sent: false,
            term_at: None,
        })
    }

    fn is_exact_group(&self) -> bool {
        self.pid == self.pgid && self.pid > 1 && unsafe { libc::getpgid(self.pid) } == self.pgid
    }

    fn signal_group(&self, signal: libc::c_int) {
        if self.is_exact_group() {
            // A negative PID targets the process group.  The exact getpgid
            // check above prevents a reused PID or an unrelated group from
            // receiving a cancellation signal.
            let _ = unsafe { libc::kill(-self.pgid, signal) };
        }
    }

    fn terminate(&mut self) {
        if self.kill_sent {
            return;
        }
        if !self.term_sent {
            self.signal_group(libc::SIGTERM);
            self.term_sent = true;
            self.term_at = Some(Instant::now());
        } else if self
            .term_at
            .is_some_and(|sent| sent.elapsed() >= Self::TERM_GRACE)
        {
            self.signal_group(libc::SIGKILL);
            self.kill_sent = true;
        }
    }

    fn leader_exited(&self) -> io::Result<bool> {
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info.si_pid == self.pid && info.si_code != 0)
    }

    fn wait(&mut self, child: &mut std::process::Child) -> io::Result<std::process::ExitStatus> {
        // Escalate without making every 100ms run-loop iteration sleep.  This
        // is intentionally bounded and also reaps the direct child.
        let deadline = Instant::now() + Self::TERM_GRACE + Duration::from_millis(100);
        loop {
            if self.leader_exited()? {
                // Keep the leader as a waitable zombie while the exact group
                // is terminated; reaping first would make getpgid(pid)
                // indistinguishable from a reused PID.
                self.terminate();
                self.signal_group(libc::SIGKILL);
                self.kill_sent = true;
                return child.wait();
            }
            self.terminate();
            if self.kill_sent || Instant::now() >= deadline {
                if !self.kill_sent {
                    self.signal_group(libc::SIGKILL);
                    self.kill_sent = true;
                }
                return child.wait();
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn progress_fields_are_validated_and_terminal_jobs_do_not_change() {
        let job = JobState::new("test".into(), PathBuf::new());
        let unsafe_fields: PdfEngineProgress = serde_json::from_value(serde_json::json!({
            "stage":"secret URL", "current":8,"total":3,
            "requestsStarted":2,"requestsCompleted":3,"receivedBytes":1024
        }))
        .unwrap();
        job.set_progress("translating".into(), Some(unsafe_fields));
        let public = job.public_status().progress.unwrap();
        assert!(public.stage.is_none());
        assert!(public.current.is_none());
        assert!(public.requests_completed.is_none());
        assert_eq!(public.received_bytes, Some(1024));
        job.finish("cancelled", "cancelled", None, None, None);
        job.set_progress("saving".into(), None);
        assert_eq!(job.public_status().phase, "cancelled");
    }

    #[test]
    fn worker_progress_roundtrips_through_native_boundary() {
        let (sender, receiver) = mpsc::channel();
        read_worker_stdout(Cursor::new(br#"{"type":"progress","phase":"translating","progress":{"stage":"translate","current":1,"total":4,"requestsStarted":2,"requestsCompleted":1,"receivedBytes":1024}}
"#.to_vec()), sender);
        match receiver.recv().unwrap() {
            WorkerEvent::Progress(phase, Some(progress)) => {
                assert_eq!(phase, "translating");
                assert_eq!(progress.current, Some(1));
                assert_eq!(progress.total, Some(4));
            }
            _ => panic!("expected progress"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_drop_terminates_worker_and_descendant() {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };
        let root = std::env::temp_dir().join(format!("readany-tree-{}", Uuid::new_v4()));
        let mut paths = EnginePaths::from_app(root.clone(), root.join("resources"));
        paths.runtime_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdf-runtime");
        assert!(
            paths.runtime_dir.join("python.exe").is_file(),
            "Prepare bundled Python before native integration tests"
        );
        fs::create_dir_all(&paths.resource_dir).unwrap();
        fs::write(paths.resource_dir.join("worker.py"), "import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])\nprint(p.pid,flush=True)\ntime.sleep(60)\n").unwrap();
        let request: PdfEngineRequest = serde_json::from_value(
            serde_json::json!({"jobId":Uuid::new_v4().to_string(),"action":"setup"}),
        )
        .unwrap();
        let mut process = spawn_worker(&request, &paths).unwrap();
        let stdout = process.child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(10));
        if line.is_err() {
            process.job.terminate();
        }
        let pid: u32 = line.expect("child PID").trim().parse().unwrap();
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        assert!(!handle.is_null());
        drop(process.job);
        assert_eq!(unsafe { WaitForSingleObject(handle, 5000) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(handle) };
        // Kill-on-close may report exit code zero on Windows; process death,
        // not a particular exit code, is the cancellation contract.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if process.child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker survived Job Object close"
            );
            thread::sleep(Duration::from_millis(10));
        }
        reader.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_lines_are_bounded() {
        let mut reader = Cursor::new(vec![b'a'; MAX_LINE_BYTES + 1]);
        let mut output = Vec::new();
        assert!(read_bounded_line(&mut reader, &mut output).is_err());
    }

    #[test]
    fn final_complete_event_survives_reader_join() {
        let (sender, receiver) = mpsc::channel();
        let worker = thread::spawn(move || {
            read_worker_stdout(
                Cursor::new(b"{\"type\":\"complete\",\"path\":\"cache.pdf\",\"cached\":false}\n"),
                sender,
            );
        });
        worker.join().expect("reader");
        assert!(matches!(
            receiver.try_recv(),
            Ok(WorkerEvent::Complete { .. })
        ));
    }

    #[test]
    fn cancellation_before_spawn_is_preserved() {
        let root = std::env::temp_dir().join(format!("readany-pdf-job-{}", Uuid::new_v4()));
        let job = JobState::new(Uuid::new_v4().to_string(), root);
        job.request_cancel();
        let (sender, receiver) = mpsc::channel();
        job.install_control(sender);
        assert!(matches!(receiver.try_recv(), Ok(ControlMessage::Cancel)));
        assert!(job.cancelled.load(Ordering::Acquire));
    }

    #[test]
    fn translate_request_requires_page_and_language() {
        let request = PdfEngineRequest {
            job_id: Uuid::new_v4().to_string(),
            action: "translate".to_string(),
            file_path: Some("sample.pdf".to_string()),
            page: None,
            target_lang: Some("zh-CN".to_string()),
            base_url: None,
            api_key: None,
            model: None,
            profile_id: None,
            use_exact_request_url: None,
            force: None,
            translation_context: None,
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn translation_context_limit_counts_utf8_bytes() {
        let valid = "界".repeat(8_000);
        assert_eq!(valid.len(), MAX_TRANSLATION_CONTEXT_BYTES);
        assert!(validate_translation_context(Some(&valid)).is_ok());
        let oversized = "界".repeat(8_001);
        assert!(oversized.len() > MAX_TRANSLATION_CONTEXT_BYTES);
        assert!(validate_translation_context(Some(&oversized)).is_err());
    }

    #[test]
    fn translation_context_is_camel_case_and_digest_is_exact_bytes() {
        let value = "{\"schemaVersion\":1}";
        let request: PdfEngineRequest = serde_json::from_value(serde_json::json!({
            "jobId": Uuid::new_v4().to_string(),
            "action": "setup",
            "translationContext": value,
        }))
        .unwrap();
        assert_eq!(request.translation_context.as_deref(), Some(value));
        let serialized = serde_json::to_value(&request).unwrap();
        assert_eq!(
            serialized
                .get("translationContext")
                .and_then(serde_json::Value::as_str),
            Some(value)
        );
        assert_ne!(
            sha256_bytes("é".as_bytes()),
            sha256_bytes("e\u{301}".as_bytes())
        );
        assert!(
            serde_json::from_value::<PdfEngineRequest>(serde_json::json!({
                "jobId": Uuid::new_v4().to_string(),
                "action": "setup",
                "translationContext": 24_001,
            }))
            .is_err()
        );
    }

    #[test]
    fn setup_worker_request_strips_context_and_credentials() {
        let request: PdfEngineRequest = serde_json::from_value(serde_json::json!({
            "jobId": Uuid::new_v4().to_string(),
            "action": "setup",
            "baseUrl": "https://example.invalid/v1",
            "apiKey": "secret",
            "model": "model",
            "translationContext": "secret context",
        }))
        .unwrap();
        let sanitized = worker_request_for_action(&request);
        assert!(sanitized.base_url.is_none());
        assert!(sanitized.api_key.is_none());
        assert!(sanitized.model.is_none());
        assert!(sanitized.translation_context.is_none());
        assert!(!safe_worker_error("context").contains("secret"));
    }

    #[test]
    fn pdf_signature_must_be_in_first_kib() {
        let mut bytes = vec![0_u8; 1024];
        bytes[1020..1024].copy_from_slice(b"%PDF");
        assert!(has_pdf_magic(&bytes));
        assert!(!has_pdf_magic(b"plain text"));
    }

    #[test]
    fn regular_pdf_input_is_checked() {
        let root = std::env::temp_dir().join(format!("readany-pdf-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir");
        let path = root.join("sample.pdf");
        fs::write(&path, b"%PDF-1.7\nexample").expect("sample");
        let result = validate_pdf_input(&path.to_string_lossy());
        assert!(result.is_ok());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn result_path_must_stay_under_cache() {
        let root = std::env::temp_dir().join(format!("readany-pdf-cache-{}", Uuid::new_v4()));
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("cache dir");
        let inside = nested.join("result.pdf");
        fs::write(&inside, b"%PDF-1.7\nresult").expect("result");
        assert!(validate_result_path(&root, &inside).is_ok());
        let outside = root
            .parent()
            .unwrap()
            .join(format!("outside-{}.pdf", Uuid::new_v4()));
        fs::write(&outside, b"%PDF-1.7\noutside").expect("outside");
        assert!(validate_result_path(&root, &outside).is_err());
        fs::remove_file(outside).expect("cleanup outside");
        fs::remove_dir_all(root).expect("cleanup cache");
    }

    #[test]
    fn export_destination_rejects_source_and_requires_explicit_overwrite() {
        let root = std::env::temp_dir().join(format!("readany-pdf-export-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir");
        #[cfg(target_os = "macos")]
        let root = fs::canonicalize(root).expect("canonical temp dir");
        let source = root.join("source.pdf");
        fs::write(&source, b"%PDF-1.7\nsource").expect("source");
        let canonical = validate_pdf_input(&path_to_json_string(&source)).expect("valid source");
        assert!(
            validate_export_destination(&canonical, &path_to_json_string(&source), true).is_err()
        );
        assert!(validate_export_destination(
            &canonical,
            &path_to_json_string(&root.join("bad.txt")),
            true
        )
        .is_err());

        let existing = root.join("translated.pdf");
        fs::write(&existing, b"old").expect("existing");
        assert!(
            validate_export_destination(&canonical, &path_to_json_string(&existing), false)
                .is_err()
        );
        let approved =
            validate_export_destination(&canonical, &path_to_json_string(&existing), true)
                .expect("approved overwrite");
        assert!(approved.exists);

        let fresh = validate_export_destination(
            &canonical,
            &path_to_json_string(&root.join("fresh.pdf")),
            false,
        )
        .expect("fresh destination");
        assert!(!fresh.exists);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(windows)]
    #[test]
    fn export_publish_atomically_replaces_an_approved_destination() {
        let root = std::env::temp_dir().join(format!("readany-pdf-publish-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("temp dir");
        let temporary = root.join(".translated.partial.pdf");
        let destination = root.join("translated.pdf");
        fs::write(&temporary, b"%PDF-1.7\nnew").expect("temporary");
        fs::write(&destination, b"%PDF-1.7\nold").expect("destination");
        atomic_publish(&temporary, &destination, true).expect("atomic publish");
        assert_eq!(fs::read(&destination).expect("published"), b"%PDF-1.7\nnew");
        assert!(!temporary.exists());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_export_is_exclusive_atomic_and_protects_source_aliases() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("readany-mac-export-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let source = root.join("source.pdf");
        let translated = root.join("cached.pdf");
        fs::write(&source, b"%PDF-1.7\nsource").unwrap();
        fs::write(&translated, b"%PDF-1.7\ntranslated").unwrap();
        let output = root.join("translated.pdf");
        let destination =
            validate_export_destination(&source, &path_to_json_string(&output), false).unwrap();
        // A competing file created after validation must not be overwritten.
        fs::write(&output, b"racing file").unwrap();
        assert!(save_export_macos(&translated, &source, &destination, false).is_err());
        assert_eq!(fs::read(&output).unwrap(), b"racing file");
        fs::remove_file(&output).unwrap();
        save_export_macos(&translated, &source, &destination, false).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"%PDF-1.7\ntranslated");
        fs::write(&translated, b"%PDF-1.7\nnew translation").unwrap();
        let approved =
            validate_export_destination(&source, &path_to_json_string(&output), true).unwrap();
        save_export_macos(&translated, &source, &approved, true).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"%PDF-1.7\nnew translation");
        let alias = root.join("source-alias.pdf");
        fs::hard_link(&source, &alias).unwrap();
        let alias_destination =
            validate_export_destination(&source, &path_to_json_string(&alias), true).unwrap();
        assert!(save_export_macos(&translated, &source, &alias_destination, true).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"%PDF-1.7\nsource");
        let linked_directory = root.join("linked");
        symlink(&root, &linked_directory).unwrap();
        assert!(validate_export_destination(
            &source,
            &path_to_json_string(&linked_directory.join("bad.pdf")),
            false
        )
        .is_err());
        assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("partial.pdf")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_runtime_paths_and_manifest_namespace_are_platform_specific() {
        let root = std::env::temp_dir().join(format!("readany-mac-paths-{}", Uuid::new_v4()));
        let resources = root.join("resources");
        fs::create_dir_all(resources.join("pdf-offline")).unwrap();
        fs::write(
            resources.join("pdf-offline/manifest.json"),
            b"first manifest",
        )
        .unwrap();
        let first = EnginePaths::from_app(root.join("data"), resources.clone());
        assert!(first.runtime_python().ends_with("pdf-runtime/bin/python3"));
        assert!(first.env_python().ends_with("env/bin/python"));
        assert!(first
            .requirements_lock()
            .ends_with("requirements.macos-arm64.lock"));
        fs::write(
            resources.join("pdf-offline/manifest.json"),
            b"second manifest",
        )
        .unwrap();
        let second = EnginePaths::from_app(root.join("data"), resources.clone());
        assert_ne!(first.engine_dir, second.engine_dir);
        let moved = EnginePaths::from_app(root.join("data"), root.join("moved-resources"));
        assert_ne!(second.engine_dir, moved.engine_dir);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_group_reaps_descendant_after_leader_exit_without_killing_unrelated_process() {
        use std::process::{Command, Stdio};
        let root = std::env::temp_dir().join(format!("readany-mac-group-{}", Uuid::new_v4()));
        let mut paths = EnginePaths::from_app(root.clone(), root.join("resources"));
        paths.runtime_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdf-runtime");
        assert!(
            paths.runtime_python().is_file(),
            "prepare bundled macOS Python first"
        );
        fs::create_dir_all(&paths.resource_dir).unwrap();
        fs::write(paths.resource_dir.join("worker.py"),
            "import subprocess,sys\np=subprocess.Popen([sys.executable,'-I','-B','-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'])\nprint(p.pid,flush=True)\n").unwrap();
        let mut unrelated = Command::new(paths.runtime_python())
            .args(["-I", "-B", "-c", "import time;time.sleep(60)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let request: PdfEngineRequest = serde_json::from_value(
            serde_json::json!({"jobId":Uuid::new_v4().to_string(),"action":"setup"}),
        )
        .unwrap();
        let mut process = spawn_worker(&request, &paths).unwrap();
        let stdout = process.child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let pid: i32 = rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if process.try_wait().unwrap().is_some() {
                break;
            }
            assert!(Instant::now() < deadline, "worker did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        reader.join().unwrap();
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "cancelled an unrelated process"
        );
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let status = Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&status.stdout);
            if state.trim().is_empty() || state.trim().starts_with('Z') {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild survived leader cleanup"
            );
            thread::sleep(Duration::from_millis(20));
        }
        fs::remove_dir_all(root).unwrap();
    }
}

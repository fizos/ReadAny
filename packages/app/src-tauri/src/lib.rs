mod db;
mod pdf_engine;
mod readany_cli;
mod storage;
mod sync;
mod vector;
mod web_fetch;

use std::sync::Mutex;
use tauri::Manager;
use vector::VectorDBState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(VectorDBState {
            db: Mutex::new(None),
        })
        .manage(pdf_engine::PdfEngineState::new())
        .invoke_handler(tauri::generate_handler![
            sync::commands::sync_vacuum_into,
            sync::commands::sync_integrity_check,
            sync::commands::sync_hash_file,
            sync::commands::get_local_ip,
            sync::lan_server::start_lan_server,
            sync::lan_server::stop_lan_server,
            sync::lan_server::lan_server_respond,
            vector::vector_insert,
            vector::vector_delete_by_book,
            vector::vector_search,
            vector::vector_get_stats,
            vector::vector_rebuild,
            vector::vector_reinit,
            vector::vector_shutdown,
            readany_cli::readany_cli_run,
            web_fetch::safe_web_fetch,
            pdf_engine::pdf_engine_info,
            pdf_engine::pdf_engine_start,
            pdf_engine::pdf_engine_status,
            pdf_engine::pdf_engine_cancel,
            pdf_engine::pdf_engine_result,
            pdf_engine::pdf_engine_plan_result,
            pdf_engine::pdf_engine_validate_export_destination,
            pdf_engine::pdf_engine_save_export,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let pdf_state = app.state::<pdf_engine::PdfEngineState>();
            match (app.path().app_local_data_dir(), app.path().resource_dir()) {
                (Ok(app_local_data_dir), Ok(resource_dir)) => {
                    if let Err(error) =
                        pdf_engine::configure_from_app(&pdf_state, app_local_data_dir, resource_dir)
                    {
                        eprintln!("[PdfEngine] Failed to initialize storage: {}", error);
                    }
                }
                _ => eprintln!("[PdfEngine] Failed to resolve application paths"),
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.set_decorations(false) {
                    eprintln!("[Window] Failed to disable system decorations: {}", e);
                }
            }

            if let Err(e) = db::init_database_sync(&app_handle) {
                eprintln!("[DB] Failed to initialize database: {}", e);
            }
            if let Err(e) = sync::lan_server::init(app) {
                eprintln!("[LAN] Failed to initialize LAN server state: {}", e);
            }
            match vector::init_vector_db(&app_handle, 384) {
                Ok(_) => println!("[VectorDB] Initialized successfully"),
                Err(e) => eprintln!("[VectorDB] Failed to initialize: {}", e),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app_handle.state::<pdf_engine::PdfEngineState>().shutdown();
            }
        });
}

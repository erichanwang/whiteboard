use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{env, fs, path::PathBuf, time::Duration};
use tauri::Manager;
use zeroize::Zeroizing;

const NVIDIA_API_URL: &str = "https://integrate.api.nvidia.com/v1";

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelRecord>,
}

#[derive(Debug, Deserialize)]
struct ModelRecord {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
    error: Option<ApiError>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryBoardSummary {
    id: String,
    title: String,
    updated_at: String,
}

const ENCRYPTED_BOARD_MAGIC: &[u8; 8] = b"WBENC\0\r\n";
const ENCRYPTED_BOARD_HEADER_LEN: usize = 64;
const MAX_BOARD_BYTES: usize = 25_000_000;

fn derive_board_key(password: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(65_536, 3, 4, Some(32))
        .map_err(|_| "Could not configure password encryption.".to_string())?;
    let mut key = [0_u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password, salt, &mut key)
        .map_err(|_| "Could not derive the encryption key.".to_string())?;
    Ok(key)
}

#[tauri::command]
fn encrypt_board(board_json: String, password: String) -> Result<Vec<u8>, String> {
    if !(8..=1024).contains(&password.len()) || board_json.len() > MAX_BOARD_BYTES {
        return Err("Use a passphrase of at least 8 characters for a valid board.".to_string());
    }
    serde_json::from_str::<Value>(&board_json)
        .map_err(|_| "The board data is not valid JSON.".to_string())?;
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let password = Zeroizing::new(password.into_bytes());
    let key = Zeroizing::new(derive_board_key(&password, &salt)?);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "Could not initialize board encryption.".to_string())?;
    let mut header = [0_u8; ENCRYPTED_BOARD_HEADER_LEN];
    header[0..8].copy_from_slice(ENCRYPTED_BOARD_MAGIC);
    header[8] = 1;
    header[9] = 1;
    header[10] = 1;
    header[12..16].copy_from_slice(&(ENCRYPTED_BOARD_HEADER_LEN as u32).to_le_bytes());
    header[16..20].copy_from_slice(&65_536_u32.to_le_bytes());
    header[20..24].copy_from_slice(&3_u32.to_le_bytes());
    header[24..28].copy_from_slice(&4_u32.to_le_bytes());
    header[28..36].copy_from_slice(&(board_json.len() as u64).to_le_bytes());
    header[36..52].copy_from_slice(&salt);
    header[52..64].copy_from_slice(&nonce);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: board_json.as_bytes(),
                aad: &header,
            },
        )
        .map_err(|_| "Could not encrypt the board.".to_string())?;
    let mut encrypted = Vec::with_capacity(header.len() + ciphertext.len());
    encrypted.extend_from_slice(&header);
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

#[tauri::command]
fn decrypt_board(encrypted: Vec<u8>, password: String) -> Result<String, String> {
    if password.is_empty()
        || password.len() > 1024
        || encrypted.len() < ENCRYPTED_BOARD_HEADER_LEN + 16
    {
        return Err("The passphrase or encrypted board is invalid.".to_string());
    }
    let header = &encrypted[..ENCRYPTED_BOARD_HEADER_LEN];
    if &header[0..8] != ENCRYPTED_BOARD_MAGIC {
        return Err("This is not an encrypted Whiteboard file.".to_string());
    }
    if header[8] != 1
        || header[9] != 1
        || header[10] != 1
        || header[11] != 0
        || u32::from_le_bytes(header[12..16].try_into().unwrap())
            != ENCRYPTED_BOARD_HEADER_LEN as u32
        || u32::from_le_bytes(header[16..20].try_into().unwrap()) != 65_536
        || u32::from_le_bytes(header[20..24].try_into().unwrap()) != 3
        || u32::from_le_bytes(header[24..28].try_into().unwrap()) != 4
    {
        return Err("This encrypted Whiteboard format is not supported.".to_string());
    }
    let plaintext_len = u64::from_le_bytes(header[28..36].try_into().unwrap());
    let expected_len = ENCRYPTED_BOARD_HEADER_LEN as u64 + plaintext_len + 16;
    if plaintext_len > MAX_BOARD_BYTES as u64 || expected_len != encrypted.len() as u64 {
        return Err("The encrypted board length is invalid.".to_string());
    }
    let password = Zeroizing::new(password.into_bytes());
    let key = Zeroizing::new(derive_board_key(&password, &header[36..52])?);
    let cipher = Aes256Gcm::new_from_slice(key.as_ref())
        .map_err(|_| "Could not initialize board decryption.".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&header[52..64]),
            Payload {
                msg: &encrypted[ENCRYPTED_BOARD_HEADER_LEN..],
                aad: header,
            },
        )
        .map_err(|_| "Could not decrypt: wrong passphrase or damaged file.".to_string())?;
    let board_json = String::from_utf8(plaintext)
        .map_err(|_| "The decrypted board is not valid text.".to_string())?;
    serde_json::from_str::<Value>(&board_json)
        .map_err(|_| "The decrypted board is not valid JSON.".to_string())?;
    Ok(board_json)
}

fn valid_board_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn library_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not find the application data directory: {error}"))?
        .join("boards");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the board library: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not secure the board library: {error}"))?;
    Ok(directory)
}

#[tauri::command]
fn save_library_board(
    app: tauri::AppHandle,
    board_json: String,
    board_id: String,
) -> Result<(), String> {
    if !valid_board_id(&board_id) || board_json.len() > 25_000_000 {
        return Err("The board data is invalid or too large.".to_string());
    }
    let parsed = serde_json::from_str::<Value>(&board_json)
        .map_err(|_| "The board data is not valid JSON.".to_string())?;
    if parsed.get("id").and_then(Value::as_str) != Some(board_id.as_str()) {
        return Err("The board ID does not match the document.".to_string());
    }
    let directory = library_directory(&app)?;
    let destination = directory.join(format!("{board_id}.whiteboard.json"));
    let temporary = directory.join(format!("{board_id}.tmp"));
    fs::write(&temporary, board_json)
        .and_then(|_| {
            #[cfg(unix)]
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))?;
            fs::rename(&temporary, &destination)
        })
        .map_err(|error| format!("Could not save the board library file: {error}"))
}

#[tauri::command]
fn list_library_boards(app: tauri::AppHandle) -> Result<Vec<LibraryBoardSummary>, String> {
    let directory = library_directory(&app)?;
    let mut boards = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not read the board library: {error}"))?
    {
        let path = match entry {
            Ok(entry) => entry.path(),
            Err(_) => continue,
        };
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let parsed = match fs::read_to_string(path)
            .ok()
            .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        {
            Some(parsed) => parsed,
            None => continue,
        };
        let (Some(id), Some(title), Some(updated_at)) = (
            parsed.get("id").and_then(Value::as_str),
            parsed.get("title").and_then(Value::as_str),
            parsed.get("updatedAt").and_then(Value::as_str),
        ) else {
            continue;
        };
        if valid_board_id(id) {
            boards.push(LibraryBoardSummary {
                id: id.to_string(),
                title: title.chars().take(200).collect(),
                updated_at: updated_at.to_string(),
            });
        }
    }
    boards.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(boards)
}

#[tauri::command]
fn open_library_board(app: tauri::AppHandle, board_id: String) -> Result<String, String> {
    if !valid_board_id(&board_id) {
        return Err("The board ID is invalid.".to_string());
    }
    fs::read_to_string(library_directory(&app)?.join(format!("{board_id}.whiteboard.json")))
        .map_err(|error| format!("Could not open the library board: {error}"))
}

fn credential(name: &str) -> Result<String, String> {
    if let Ok(value) = env::var(name) {
        if !value.trim().is_empty() {
            return Ok(value);
        }
    }

    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not find the home directory.".to_string())?;
    let contents = fs::read_to_string(home.join(".fcc/.env"))
        .map_err(|_| format!("{name} was not found in the environment or ~/.fcc/.env."))?;

    for line in contents.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((key, raw_value)) = line.split_once('=') {
            if key.trim() == name {
                let value = raw_value.trim().trim_matches(['\'', '"']);
                if !value.is_empty() {
                    return Ok(value.to_string());
                }
            }
        }
    }

    Err(format!("{name} is empty in ~/.fcc/.env."))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("NVIDIA API returned {status}."))
}

fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Could not initialize the NVIDIA client: {error}"))
}

fn valid_image_payload(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

#[tauri::command]
async fn list_nvidia_models() -> Result<Vec<String>, String> {
    let key = credential("NVIDIA_NIM_API_KEY")?;
    let response = api_client()?
        .get(format!("{NVIDIA_API_URL}/models"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| format!("Could not reach NVIDIA API: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read NVIDIA response: {error}"))?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }
    let mut models = serde_json::from_str::<ModelsResponse>(&body)
        .map_err(|_| "NVIDIA returned an invalid model list.".to_string())?
        .data
        .into_iter()
        .map(|record| record.id)
        .collect::<Vec<_>>();
    models.sort();
    Ok(models)
}

#[tauri::command]
async fn recognize_with_nvidia(
    image: String,
    mode: String,
    model: String,
    corrections: Vec<String>,
    profile_image: Option<String>,
) -> Result<String, String> {
    if mode != "text" && mode != "latex" {
        return Err("Recognition mode must be text or latex.".to_string());
    }
    if model.is_empty()
        || model.len() > 160
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.'))
    {
        return Err("The model name is invalid.".to_string());
    }
    if !valid_image_payload(&image, 12_000_000) {
        return Err("The recognition image is invalid or too large.".to_string());
    }
    if corrections.len() > 100 || corrections.iter().any(|correction| correction.len() > 500) {
        return Err("The correction history is too large.".to_string());
    }
    if profile_image
        .as_deref()
        .is_some_and(|value| !valid_image_payload(value, 16_000_000))
    {
        return Err("The handwriting profile image is invalid or too large.".to_string());
    }
    let key = credential("NVIDIA_NIM_API_KEY")?;
    let instruction = if mode == "latex" {
        "Read only the handwritten mathematical expression in the final image. Return valid LaTeX only, without delimiters, prose, or markdown fences."
    } else {
        "Read only the handwriting in the final image. Return the transcription only, preserving line breaks. Do not explain."
    };

    let mut messages = Vec::<Value>::new();
    if let Some(profile_image) = profile_image {
        messages.push(json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "This is the user's labeled handwriting reference sheet. Use it only to learn their letter and symbol shapes for the final image." },
                { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{profile_image}") } }
            ]
        }));
    }

    let hints = if corrections.is_empty() {
        String::new()
    } else {
        format!(
            "\nPrefer these user-confirmed corrections when relevant:\n{}",
            corrections.join("\n")
        )
    };
    messages.push(json!({
        "role": "user",
        "content": [
            { "type": "text", "text": format!("{instruction}{hints}") },
            { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{image}") } }
        ]
    }));

    let response = api_client()?
        .post(format!("{NVIDIA_API_URL}/chat/completions"))
        .bearer_auth(key)
        .json(&json!({
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 1024,
            "stream": false
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach NVIDIA API: {error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read NVIDIA response: {error}"))?;
    if !status.is_success() {
        return Err(api_error(status, &body));
    }

    let parsed = serde_json::from_str::<ChatResponse>(&body)
        .map_err(|_| "NVIDIA returned an invalid recognition response.".to_string())?;
    if let Some(error) = parsed.error {
        return Err(error.message);
    }
    parsed
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content.trim().to_string())
        .filter(|content| !content.is_empty())
        .ok_or_else(|| "The model returned no text.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_nvidia_models,
            recognize_with_nvidia,
            save_library_board,
            list_library_boards,
            open_library_board,
            encrypt_board,
            decrypt_board
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{decrypt_board, encrypt_board};

    #[test]
    fn encrypted_board_round_trip_and_wrong_password_rejection() {
        let board = r#"{"version":1,"id":"test-board"}"#;
        let encrypted = encrypt_board(
            board.to_string(),
            "correct horse battery staple".to_string(),
        )
        .unwrap();
        assert_ne!(encrypted.as_slice(), board.as_bytes());
        assert_eq!(
            decrypt_board(
                encrypted.clone(),
                "correct horse battery staple".to_string()
            )
            .unwrap(),
            board
        );
        assert!(decrypt_board(encrypted, "wrong password".to_string()).is_err());
    }
}

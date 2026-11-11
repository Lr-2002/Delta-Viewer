//! Read local OS network inventory only; never contact a device or OTA endpoint.
fn main() {
    match serde_json::to_string_pretty(&dohc_viewer_lib::d1_link::snapshot()) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        let common_controls = "/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'";
        println!("cargo:rustc-link-arg={common_controls}");
    }

    tauri_build::build()
}

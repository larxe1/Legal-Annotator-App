fn main() {
    println!("cargo:rerun-if-changed=../ui");
    println!("cargo:rerun-if-changed=../ui/index.html");
    println!("cargo:rerun-if-changed=../ui/src");
    println!("cargo:rerun-if-changed=../version.json");
    tauri_build::build()
}

//! Build script for the prosody-js project.

/// Configures the build process for the Node.js native addon.
fn main() {
    // Set up the napi-rs build environment
    napi_build::setup();

    // napi-build declares only environment inputs. Declare this file too, so
    // Cargo-Rail does not treat every file in the package as an input.
    println!("cargo::rerun-if-changed=build.rs");
}

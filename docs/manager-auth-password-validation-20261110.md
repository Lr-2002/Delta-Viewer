# Login Password Visibility Validation

The 1.7.7 preview added a masked password field with an accessible show/hide control. Toggling visibility preserves the entered value; switching between login and registration clears the value and returns to the masked state. The control is disabled while authentication is busy. Wi-Fi refresh and manual password actions use the same secondary-button styling as the rest of the Manager UI.

Browser tests covered the visibility toggle, retained value, mode reset, keyboard focus, and disabled state. The previous Windows preview was opened under a separate application identifier and data directory; it did not replace the Viewer profile.

Machine-specific build paths, hashes, process IDs, screenshots, account configuration, and device observations remain in private diagnostics. This is historical preview evidence, not the 1.7.8 release result.

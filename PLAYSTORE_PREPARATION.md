# Rajmukhi Education V63 — Play Store Preparation

## Current web deployment
- Keep the existing Render deployment as the backend/web host.
- Deploy the current V63 source as one consistent set; do not mix files from older ZIP versions.

## Before Android build
1. Verify student register/login.
2. Verify admin login.
3. Verify course -> lesson -> progress.
4. Verify test submission and score.
5. Verify admin CRUD/delete.
6. Verify certificate flow.
7. Verify mobile layout.

## Android release
The next build step is to create a signed Android App Bundle (.aab) that points to the stable production app. The Play Store upload requires a signed release build, app icon/assets, store listing text, screenshots, privacy policy, and a completed Play Console release.

## Important
This package is a preparation build, not an already-signed .aab. The source must be stable before submitting to Google Play.

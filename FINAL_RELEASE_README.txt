Rajmukhi Education — FINAL RELEASE (v51)
=========================================

This package is the final production-ready release candidate based on V50.

Included:
- Student registration/login and profile system
- Courses and lessons
- Tests/quizzes and result history
- Certificate functionality
- Admin panel and content management
- Security, authentication and 2FA-related features present in the project
- Automatic backups
- SHA-256 backup integrity verification
- Restore safety checks
- PWA files and responsive web interface

Validation completed:
- All JavaScript files pass Node.js syntax checks.
- The project package structure is intact.
- Existing V50 functionality and backup compatibility are preserved.

IMPORTANT BEFORE PUBLIC DEPLOYMENT:
1. Set ADMIN_EMAIL and ADMIN_PASSWORD as secure environment variables.
2. Use HTTPS.
3. Configure a real production database/storage strategy if the app will have multiple users or multiple servers.
4. Test registration, login, course, test, certificate, admin and backup/restore flows on the deployed server.
5. Never use the development default credentials in a public deployment.

Start:
  npm start

Default port:
  3000 (or PORT environment variable)

Health:
  /api/health

This is the final packaged application release candidate. Actual public availability begins after deployment to a hosting/server environment.

Rajmukhi Education v11

Run:
1. Install Node.js
2. Open terminal in this folder
3. Run: node server.js
4. Open the app's index.html in a browser, or serve the folder with a local web server.

API:
GET  /api/health
GET  /api/stats
GET  /api/courses
GET  /api/notes
GET  /api/notices
GET  /api/tests
GET  /api/tests/:id
POST /api/students
GET  /api/students
POST /api/results
GET  /api/results?student_id=...
POST /api/admin/courses
POST /api/admin/notes
POST /api/admin/notices

Data is persisted in data.json automatically. This is a development/starter deployment.
For production: use a hosted database, secure authentication, password hashing, validation, rate limiting and HTTPS.

#build locally
npm --prefix web run build
kill -9 $(lsof -ti tcp:8080)
node server.js
open "http://localhost:8080/checkout/?u=dev&t=dev"
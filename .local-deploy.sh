npm --prefix web run build

# kill anything already on 8080 (ignore error if none)
kill -9 $(lsof -ti tcp:8080) 2>/dev/null || true

# start server in background
node server.js &

# (optional) small delay so server has time to start
sleep 2

# open browser
open "http://localhost:8080/checkout/?u=dev&t=dev"
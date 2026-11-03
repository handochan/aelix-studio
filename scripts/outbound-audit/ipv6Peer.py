import http.server,json,socket,threading,sys
from pathlib import Path
class Server(http.server.ThreadingHTTPServer):
    address_family=socket.AF_INET6
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body=b'<!doctype html><title>IPv6 fixture</title><p>fixture</p>'
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def log_message(self,*_args):pass
for port in (443,9999):
    connection=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM);connection.bind(('::',port))
    def receive(connection=connection,port=port):
        while True:
            payload,source=connection.recvfrom(1024)
            with open(sys.argv[1]+'/peer-control.jsonl','a') as output: output.write(json.dumps({'port':port,'source':source[0],'bytes':len(payload)})+'\n')
    threading.Thread(target=receive,daemon=True).start()
Path(sys.argv[1]+'/peer-ready').touch()
Server(('::',18080),Handler).serve_forever()

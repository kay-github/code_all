"""Read-only preview at http://127.0.0.1:8768/gjd/."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
import mimetypes
import pipeline
from v2_common import DATA,read_json

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        pointer=read_json(DATA/'latest.json')
        if pointer['build_id']!=self.server.build_id:
            a,folder=pipeline.latest();self.server.build_folder=folder;self.server.build_id=a['build_id']
        folder=self.server.build_folder
        path=urlparse(self.path).path
        if path in ['/','/gjd','/gjd/']:
            target=folder/'report.html'
        elif path in ['/gjd/cycle','/gjd/cycle/']:
            target=folder/'cycle.html'
        elif path.startswith('/assets/'):
            target=(Path('D:/code_all')/path.lstrip('/')).resolve()
            if not target.is_relative_to(Path('D:/code_all/assets').resolve()):self.send_error(403);return
        else:
            self.send_error(404);return
        if not target.is_file():self.send_error(404);return
        data=target.read_bytes();self.send_response(200)
        self.send_header('Content-Type',(mimetypes.guess_type(str(target))[0] or 'application/octet-stream')+'; charset=utf-8')
        self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)))
        self.end_headers();self.wfile.write(data)

if __name__=='__main__':
    print('Preview http://127.0.0.1:8768/gjd/',flush=True)
    a,folder=pipeline.latest()
    server=ThreadingHTTPServer(('127.0.0.1',8768),Handler)
    server.build_folder=folder
    server.build_id=a['build_id']
    server.serve_forever()

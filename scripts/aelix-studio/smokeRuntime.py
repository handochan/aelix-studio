import asyncio, json, os, sys, tempfile
from pathlib import Path

async def main():
    runtime=Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='as-', dir='/tmp') as tmp:
        env={**os.environ, 'HOME':tmp, 'PATH':'/usr/bin:/bin', 'PYTHONPATH':'/invalid', 'PYTHONHOME':'/invalid'}
        proc=await asyncio.create_subprocess_exec(str(runtime/'bin/aelix-acp'), '--state-dir',tmp+'/state',cwd=tmp,env=env,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        async def request(i,method,params):
            proc.stdin.write((json.dumps(dict(jsonrpc='2.0',id=i,method=method,params=params))+'\n').encode());await proc.stdin.drain()
            while True:
                line=await asyncio.wait_for(proc.stdout.readline(),30)
                if not line: raise RuntimeError((await proc.stderr.read()).decode())
                result=json.loads(line)
                if result.get('id')==i:
                    if 'error' in result:raise RuntimeError(result['error'])
                    return result['result']
        try:
            init=await request(1,'initialize',dict(protocolVersion=1,clientCapabilities={},clientInfo={'name':'studio-bundle-smoke','version':'1'}))
            new=await request(2,'session/new',dict(cwd=tmp,mcpServers=[]))
            print(json.dumps({'protocolVersion':init['protocolVersion'],'agentInfo':init['agentInfo'], 'sessionCreated':bool(new['sessionId']),'runtime':str(runtime)}))
        finally:
            proc.terminate(); await asyncio.wait_for(proc.wait(),15)
asyncio.run(main())

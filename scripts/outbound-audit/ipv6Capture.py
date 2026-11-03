"""Isolated Linux IPv6-route experiment; never changes the production audit policy.

Run only in a disposable --network none Docker container with the documented
capabilities. Captures Ethernet + IPv6 headers (54 bytes), not transport payloads.
"""
import argparse,collections,hashlib,ipaddress,json,os,re,signal,struct,subprocess,time
from pathlib import Path
PROBE='2001:4860:4860::8888'
PEER='2001:db8:15::2'
HERE=Path(__file__).resolve().parent

def run(args,check=True,**kwargs):
    return subprocess.run(args,check=check,text=True,capture_output=True,**kwargs)

def read_pcap(path):
    """Reject incomplete captures; count address/protocol headers without payloads."""
    data=path.read_bytes()
    if len(data)<24: raise ValueError('Missing pcap header')
    endian={b'\xd4\xc3\xb2\xa1':'<',b'\xa1\xb2\xc3\xd4':'>'}.get(data[:4])
    if not endian: raise ValueError('Unsupported pcap format')
    _,major,minor,_,_,snaplen,link=struct.unpack(endian+'IHHIIII',data[:24])
    if (major,minor,snaplen,link)!=(2,4,54,1): raise ValueError('Require Ethernet IPv6-header-only capture')
    offset=24;counts=collections.Counter();destinations=collections.Counter()
    while offset<len(data):
        if offset+16>len(data):raise ValueError('Truncated packet record')
        _,_,length,original=struct.unpack(endian+'IIII',data[offset:offset+16]);offset+=16
        frame=data[offset:offset+length];offset+=length
        if len(frame)!=length or length!=54 or original<54:raise ValueError('Incomplete IPv6 header')
        if frame[12:14]!=b'\x86\xdd' or frame[14]>>4!=6:raise ValueError('Unexpected non-IPv6 frame')
        source=str(ipaddress.IPv6Address(frame[22:38]));destination=str(ipaddress.IPv6Address(frame[38:54]));protocol=frame[20]
        counts['frames']+=1;destinations[destination]+=1
        if destination==PROBE:counts['toProbe']+=1
        if source==PROBE:counts['fromProbe']+=1
        if protocol==6:counts['tcp']+=1
        elif protocol==17:counts['udp']+=1
        elif protocol==58:counts['icmpv6']+=1
        else:counts['otherProtocol']+=1
    return dict(snaplen=snaplen,linkType=link,**{key:counts[key] for key in ('frames','toProbe','fromProbe','tcp','udp','icmpv6','otherProtocol')},destinations=dict(destinations))

def start_capture(path):
    log=path.with_suffix('.tcpdump.log').open('w+')
    process=subprocess.Popen(['tcpdump','--immediate-mode','-i','probe0','-n','-U','-s','54','-w',str(path),'ip6'],stdout=subprocess.DEVNULL,stderr=log)
    for _ in range(100):
        if process.poll() is not None:raise RuntimeError('tcpdump exited before ready')
        log.flush()
        if 'listening on' in path.with_suffix('.tcpdump.log').read_text():return process,log
        time.sleep(0.02)
    raise RuntimeError('tcpdump readiness missing')

def stop_capture(process,log,path):
    time.sleep(.1);process.send_signal(signal.SIGINT);process.wait(timeout=10);log.close()
    message=path.with_suffix('.tcpdump.log').read_text()
    if process.returncode or not re.search(r'\b0 packets dropped by kernel\b',message):raise RuntimeError('Capture incomplete or dropped packets')
    result=read_pcap(path)
    captured=re.search(r'(\d+) packets? captured',message)
    received=re.search(r'(\d+) packets? received by filter',message)
    if not captured or not received or int(captured.group(1))!=result['frames'] or int(received.group(1))!=result['frames']:raise RuntimeError('Capture did not drain all filtered packets')
    result['kernelDropped']=0;result['sha256']=hashlib.sha256(path.read_bytes()).hexdigest();return result

def parse_trace(path):
    """Join per-thread syscall continuations before counting the fixed UDP probe."""
    records=[];pending={};unknown=0
    for raw in path.read_text().splitlines():
        match=re.match(r'^(\d+)<[^>]+>\s+(.*)$',raw)
        if not match:raise ValueError('Missing trace thread identity')
        tid,line=match.groups()
        if '<unfinished ...>' in line:
            if tid in pending:raise ValueError('Overlapping unfinished syscall')
            pending[tid]=line.replace('<unfinished ...>','')
        elif line.startswith('<... ') and ' resumed>' in line:
            if tid not in pending:raise ValueError('Resumed syscall without entry')
            records.append(pending.pop(tid)+line.split(' resumed>',1)[1])
        elif line.startswith('+++'):
            if tid in pending:
                interrupted=pending.pop(tid)
                if PROBE in interrupted and re.match(r'^(connect|sendto|sendmsg|sendmmsg)\(',interrupted):raise ValueError('Probe return value missing at exit')
            records.append(line)
        else:records.append(line)
    if pending:raise ValueError('Trace ends without terminal evidence')
    calls=[]
    for line in records:
        if line.startswith('???('):unknown+=1
        if line.startswith('connect(') and 'sa_family=AF_INET6' in line and f'"{PROBE}"' in line:
            if '<UDPv6:' not in line:raise ValueError('Probe descriptor is not UDPv6')
            status=re.search(r'\)\s+= (.*)$',line)
            if not status:raise ValueError('Probe syscall result is incomplete')
            calls.append(status.group(1))
    sends=[line for line in records if re.match(r'^(sendto|sendmsg|sendmmsg)\(',line) and PROBE in line]
    return {'probeConnects':len(calls),'probeConnectResults':calls,'probeSendCalls':len(sends),'unknownSyscallRecords':unknown}


def setup(root):
    interfaces=json.loads(run(['ip','-j','link','show']).stdout)
    if not Path('/.dockerenv').exists() or {item['ifname'] for item in interfaces}!={'lo'}:
        raise RuntimeError('Require a disposable --network none Docker namespace')
    for args in [
      ['ip','link','set','lo','up'],['ip','netns','add','ipv6-peer'],
      ['ip','link','add','probe0','type','veth','peer','name','sink0'],
      ['ip','link','set','sink0','netns','ipv6-peer'],
      ['ip','link','set','probe0','address','02:00:00:15:00:01','addrgenmode','none'],
      ['ip','-n','ipv6-peer','link','set','sink0','address','02:00:00:15:00:02','addrgenmode','none'],
      ['ip','-6','addr','add','2001:db8:15::1/64','dev','probe0','nodad'],
      ['ip','-n','ipv6-peer','-6','addr','add',PEER+'/64','dev','sink0','nodad'],
      ['ip','-n','ipv6-peer','-6','addr','add',PROBE+'/128','dev','sink0','nodad'],
      ['ip','link','set','probe0','up'],['ip','-n','ipv6-peer','link','set','lo','up'],['ip','-n','ipv6-peer','link','set','sink0','up'],
      ['ip','-6','neigh','replace',PEER,'lladdr','02:00:00:15:00:02','nud','permanent','dev','probe0'],
      ['ip','-n','ipv6-peer','-6','neigh','replace','2001:db8:15::1','lladdr','02:00:00:15:00:01','nud','permanent','dev','sink0'],
    ]:run(args)
    with open('/etc/hosts','a') as hosts:hosts.write('\n'+PEER+' v6probe.test\n')
    (root/'peer-ready').unlink(missing_ok=True)
    log=(root/'peer.log').open('w')
    peer=subprocess.Popen(['ip','netns','exec','ipv6-peer','python3',str(HERE/'ipv6Peer.py'),str(root)],stdout=log,stderr=log)
    for _ in range(100):
        if (root/'peer-ready').exists():return peer,log
        if peer.poll() is not None:raise RuntimeError('Peer failed')
        time.sleep(.02)
    raise RuntimeError('Peer readiness timeout')

def case(root,executable,variant,route,cold=False):
    output=root/(executable.parent.name+'-'+variant+'-'+route+('-cold' if cold else ''));output.mkdir()
    run(['ip','-6','route','del',PROBE+'/128'],check=False)
    if route=='present':run(['ip','-6','route','add',PROBE+'/128','via',PEER,'dev','probe0'])
    if cold:run(['ip','-6','neigh','del',PEER,'dev','probe0'],check=False)
    else:run(['ip','-6','neigh','replace',PEER,'lladdr','02:00:00:15:00:02','nud','permanent','dev','probe0'])
    routing=run(['ip','-6','route','get',PROBE],check=False)
    (output/'route.txt').write_text(routing.stdout+routing.stderr)
    if (route=='present')!=(routing.returncode==0):raise RuntimeError('Route topology mismatch')
    env={key:value for key,value in os.environ.items() if key in ('PATH','DISPLAY','LANG')}
    for key in ('HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME'):env[key]=str(output/key.lower());Path(env[key]).mkdir()
    env.update(IPV6_VARIANT=variant,IPV6_RESULT=str(output/'application.json'))
    if cold:env['IPV6_ONLY']='1'
    flags=['--no-sandbox','--disable-gpu','--log-net-log='+str(output/'netlog.json')]
    if variant!='default':flags+=['--disable-background-networking','--disable-component-update','--disable-domain-reliability']
    if variant=='override':flags+=['--enable-features=EnableIPv6ReachabilityOverride']
    if variant=='happy-feature':flags+=['--enable-features=HappyEyeballsV3']
    if variant=='host-rules':flags+=['--host-resolver-rules=MAP v6probe.test [2001:db8:15::2]']
    capture,log=start_capture(output/'probe.pcap')
    command=['strace','-f','-Y','-yy','-q','-s','0','-e','trace=socket,connect,getsockname,sendto,sendmsg,sendmmsg','-o',str(output/'syscalls.trace'),str(executable),*flags,str(HERE/'ipv6Probe.cjs')]
    result=run(command,check=False,env=env,timeout=40)
    (output/'application.log').write_text(result.stdout+result.stderr)
    packets=stop_capture(capture,log,output/'probe.pcap')
    if result.returncode:raise RuntimeError('Electron failed: '+str(output))
    app=json.loads((output/'application.json').read_text());trace=parse_trace(output/'syscalls.trace')
    if variant=='default' and not trace['probeConnects']:raise RuntimeError('Default baseline did not exercise probe')
    if not cold and not next(x['ok'] for x in app['results'] if x['label']=='ipv6Literal'):raise RuntimeError('IPv6 endpoint failed')
    capture,log=start_capture(output/'positive.pcap')
    targets=[PEER]+([PROBE] if route=='present' else [])
    code='import socket\ns=socket.socket(socket.AF_INET6,socket.SOCK_DGRAM)\n'+''.join('s.sendto(b"controlled", ('+repr(target)+', '+('443' if target==PROBE else '9999')+'))\n' for target in targets)
    run(['python3','-c',code]);time.sleep(.2)
    positive=stop_capture(capture,log,output/'positive.pcap')
    if positive['udp']!=len(targets) or positive['toProbe']!=(1 if route=='present' else 0):raise RuntimeError('Packet positive control failed')
    report={'route':route,'coldNeighborProbeOnly':cold,'routeLookup':routing.stdout+routing.stderr,'executableSha256':hashlib.sha256(executable.read_bytes()).hexdigest(),'app':app,'syscalls':trace,'wire':packets,'positive':positive}
    (output/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'engine':app['versions']['electron'],'variant':variant,'route':route,'cold':cold,'syscalls':trace['probeConnects'],'wireToProbe':packets['toProbe'],'wireFromProbe':packets['fromProbe'],'endpointResults':app['results'],'positivePackets':positive['udp']}),flush=True)
    return report

def audit_case(root,executable,route,audit_script):
    output=root/('audit-'+route);output.mkdir()
    run(['ip','-6','route','del',PROBE+'/128'],check=False)
    if route=='present':run(['ip','-6','route','add',PROBE+'/128','via',PEER,'dev','probe0'])
    env={key:value for key,value in os.environ.items() if key in ('PATH','DISPLAY','LANG')}
    env.update(HOME=str(output/'home'),IPV6_VARIANT='production',IPV6_ONLY='1',IPV6_RESULT=str(output/'application.json'))
    Path(env['HOME']).mkdir()
    capture,log=start_capture(output/'probe.pcap')
    result=run(['python3',str(audit_script),'--report',str(output/'audit.json'),'--',str(executable),'--no-sandbox','--disable-gpu',str(HERE/'ipv6Probe.cjs')],check=False,env=env,timeout=40)
    (output/'command.log').write_text(result.stdout+result.stderr)
    wire=stop_capture(capture,log,output/'probe.pcap')
    audit=json.loads((output/'audit.json').read_text())
    if result.returncode not in (86,87) or not audit['externalAttempts']:
        raise RuntimeError('Production audit must retain its blocking failure')
    if not any(event['address']==PROBE for process in audit['processes'] for event in process['external']):
        raise RuntimeError('Production audit did not detect the route probe')
    return {'route':route,'exitCode':result.returncode,'audit':audit,'wire':wire}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--current',type=Path,default=Path('/app/node_modules/electron/dist/electron'))
    parser.add_argument('--candidate',type=Path)
    parser.add_argument('--audit-script',type=Path,default=HERE/'audit.py')
    args=parser.parse_args();root=args.output.resolve();root.mkdir(parents=True)
    peer,peerlog=setup(root)
    displaylog=(root/'display.log').open('w')
    display=subprocess.Popen(['Xvfb',':98','-screen','0','1024x768x24'],stdout=displaylog,stderr=displaylog)
    os.environ['DISPLAY']=':98';time.sleep(.3)
    records=[];audits=[]
    engines=[(args.current,['default','production','builtin-on','happy-api','additional-off','override','happy-feature','host-rules'])]
    if args.candidate:engines.append((args.candidate,['default','production','override','happy-api']))
    try:
        for binary,variants in engines:
            for variant in variants:
                for route in ('absent','present'):records.append(case(root,binary,variant,route))
        for binary,_ in engines:
            for route in ('absent','present'):records.append(case(root,binary,'default',route,cold=True))
        for route in ('absent','present'):audits.append(audit_case(root,args.current,route,args.audit_script))
        metadata={
            'schema':'aelix-studio.ipv6-probe-investigation/1',
            'kernel':run(['uname','-a']).stdout.strip(),
            'tcpdump':run(['tcpdump','--version']).stdout.splitlines()[0],
            'strace':run(['strace','--version']).stdout.splitlines()[0],
            'recipes':{name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in ('ipv6Capture.py','ipv6Probe.cjs','ipv6Peer.py')},
            'records':records,'unchangedAuditChecks':audits,
        }
        (root/'summary.json').write_text(json.dumps(metadata,indent=2)+'\n')
    finally:
        peer.terminate();peer.wait(timeout=5);peerlog.close()
        display.terminate();display.wait(timeout=5);displaylog.close()
        run(['ip','netns','del','ipv6-peer'])


if __name__=='__main__':main()

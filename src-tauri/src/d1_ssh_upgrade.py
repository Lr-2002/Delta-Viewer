"""Fixed Manager SSH operation. No caller-supplied shell commands.

Read is side-effect free. Launch persists an attempt before starting a detached
systemd worker; losing Wi-Fi or the Manager process does not abort dpkg.
"""
import base64
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

ROOT = Path('/var/lib/dohc-manager-upgrade')
LIMIT = 512 * 1024 * 1024


def load(path, default=None):
    try:
        if path.stat().st_size > 1024 * 1024:
            raise ValueError('OTA_STATUS_TOO_LARGE')
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write(path, value):
    temporary = path.with_suffix('.new')
    with temporary.open('w') as handle:
        json.dump(value, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(temporary), str(path))


def config():
    result = {}
    try:
        for line in Path('/etc/dohc/runtime.env').read_text().splitlines():
            key, separator, value = line.strip().partition('=')
            if separator and not key.startswith('#'):
                result[key] = value.strip().strip('"\'')
    except FileNotFoundError:
        pass
    return result


def health():
    cfg = config()
    url = cfg.get('DOHC_OTA_HEALTH_URL', 'http://127.0.0.1:%d/health' % int(cfg.get('DOHC_WEB_PORT', '80')))
    parsed = urlsplit(url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password:
        raise ValueError('OTA_HEALTH_URL_INVALID: 健康检查必须使用设备本机 HTTP 地址')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(url, timeout=3)
    except urllib.error.HTTPError as error:
        if error.code != 503:
            raise
        response = error
    with response:
        body = response.read(512 * 1024 + 1)
    if len(body) > 512 * 1024:
        raise ValueError('OTA_HEALTH_TOO_LARGE')
    report = json.loads(body)
    if not isinstance(report, dict):
        raise ValueError('OTA_HEALTH_INVALID')
    return report


def identity():
    cfg = config()
    cid = Path(cfg.get('DOHC_EMMC_CID_PATH', '/sys/block/mmcblk0/device/cid')).read_text().strip().lower()
    if not re.fullmatch('[0-9a-f]{32}', cid):
        raise ValueError('OTA_CID_INVALID: 无法读取完整硬件 CID')
    device = Path(cfg.get('DOHC_DEVICE_ID_PATH', '/var/lib/dohc/device-id')).read_text().strip()
    try:
        value = json.loads(device)
        if isinstance(value, dict):
            device = value.get('device_id', value.get('id', ''))
        elif isinstance(value, str):
            device = value
    except ValueError:
        pass
    device = str(uuid.UUID(device))
    release = load(Path('/opt/dohc/current/RELEASE.json'), {})
    return dict(deviceId=device, cid=cid, releaseId=release.get('release_id'),
                version=Path('/opt/dohc/current/VERSION').read_text().strip())


def current():
    latest = load(ROOT / 'latest.json', {})
    operation = latest.get('operationId', '')
    if re.fullmatch('[0-9a-f]{32}', operation):
        record = load(ROOT / operation / 'status.json', {})
        if record:
            # A reboot/worker crash must never leave an endless false "installing".
            if record.get('active'):
                unit = 'dohc-manager-upgrade-' + operation
                result = subprocess.run(['systemctl', 'is-active', '--quiet', unit], timeout=4)
                if result.returncode and time.time() * 1000 - record['updatedAtMs'] > 15000:
                    record.update(active=False, finalState=False, state='UNKNOWN', result=None,
                                  reason='升级工作进程已停止，安装结果尚未确认；请查看日志。')
            return record
    return dict(available=True, state='IDLE', result=None, operationId=None,
                active=False, finalState=False, failureCodes=[], reason=None, events=[])


def read():
    result = current()
    result.update(identity())
    result['available'] = all(shutil.which(x) for x in ('python3', 'dpkg', 'dpkg-deb', 'systemd-run'))
    result['transport'] = 'ssh'
    return result


def power_check():
    cfg = config()
    report = health()
    if report.get('heartbeat_stale') is True:
        raise ValueError('OTA_HEALTH_STALE: 当前健康报告已过期')
    # Same idle/storage-only fault exception as the device's Factory updater.
    critical = [item for item in report.get('alerts', []) if isinstance(item, dict) and str(item.get('severity', '')).lower() == 'critical']
    storage_blocked = (report.get('phase') == 'FAULT' and report.get('health') == 'FAILED'
                       and not report.get('heartbeat_stale') and not report.get('missing_required')
                       and not report.get('runtime_fault') and (report.get('storage') or {}).get('writable') is False
                       and critical and all(item.get('component') == 'storage.sd' for item in critical)
                       and not report.get('can_start'))
    recording = report.get('recording') or {}
    if (report.get('phase') != 'IDLE' and not storage_blocked) or report.get('can_stop') or report.get('recording_session') or recording.get('session'):
        raise ValueError('OTA_DEVICE_BUSY: 请先停止录制、自检或压力测试')
    writer = report.get('writer') or recording.get('writer') or {}
    if writer.get('operation_active') or int(writer.get('queue_depth') or 0) != 0:
        raise ValueError('OTA_WRITER_BUSY: 请等待录制写入队列完成')
    if (report.get('self_test') or {}).get('phase') == 'RUNNING' or (report.get('stress') or {}).get('phase') == 'RUNNING':
        raise ValueError('OTA_DEVICE_BUSY: 请先停止自检或压力测试')
    if report.get('missing_required'):
        raise ValueError('OTA_REQUIRED_COMPONENT_MISSING: 必需组件尚未就绪')
    power = report.get('power') or {}
    telemetry = (report.get('monitor') or {}).get('telemetry') or report.get('telemetry') or {}
    temperature = power.get('temperature', telemetry.get('chip_temp'))
    voltage = power.get('voltage', telemetry.get('vcc_voltage'))
    maximum = float(cfg.get('DOHC_OTA_MAX_TEMPERATURE', '75'))
    minimum = float(cfg.get('DOHC_OTA_MIN_VOLTAGE', '7.3'))
    if temperature is None or not math.isfinite(float(temperature)):
        raise ValueError('OTA_TEMPERATURE_UNKNOWN: 无法读取当前温度')
    if float(temperature) >= maximum:
        raise ValueError('OTA_TEMPERATURE_UNSAFE: 当前温度达到设备升级上限')
    if cfg.get('DOHC_OTA_EXTERNAL_POWER_ASSURED', 'false').lower() not in ('true', '1', 'yes'):
        if voltage is None or not math.isfinite(float(voltage)):
            raise ValueError('OTA_POWER_UNKNOWN: 无法读取当前供电电压')
        if float(voltage) < minimum:
            raise ValueError('OTA_POWER_UNSAFE: 当前电压低于设备升级门限 %.2fV' % minimum)


def same_release(actual, payload):
    # A version label alone must not hide a different build of that version.
    return actual['version'] == payload['version'] and actual.get('releaseId') == payload['releaseId']


def announce_current():
    """Use the installed prompt player, including its shared PCM/GPIO lock."""
    code = """import os,sys
sys.path.insert(0, '/opt/dohc/current')
from system_monitor import config
from system_monitor.audio_prompts import PROMPT_OTA_UP_TO_DATE, play_runtime_prompt
raise SystemExit(0 if play_runtime_prompt(PROMPT_OTA_UP_TO_DATE, config=config) else 1)
"""
    try:
        environment = dict(os.environ)
        environment.update({key: value for key, value in config().items() if key.startswith('DOHC_')})
        result = subprocess.run(['/usr/bin/python3', '-c', code], env=environment,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def current_record(directory, payload, actual):
    now = int(time.time() * 1000)
    message = '当前已是最新版本 %s，无需升级。' % payload['version']
    record = dict(available=True, state='UP_TO_DATE', result='UP_TO_DATE',
                  operationId=payload['operationId'], deviceId=actual['deviceId'], cid=actual['cid'],
                  releaseBefore=actual['version'], releaseTarget=payload['releaseId'],
                  targetVersion=payload['version'], active=False, finalState=True,
                  startedAtMs=now, updatedAtMs=now, failureCodes=[], reason=None,
                  guidance=message, events=[dict(atMs=now, level='info', message=message)])
    write(directory / 'request.json', payload)
    write(directory / 'status.json', record)
    write(ROOT / 'latest.json', dict(operationId=payload['operationId']))
    # Persist intent first: retries/polling never replay an audible prompt.
    played = announce_current()
    record['updatedAtMs'] = int(time.time() * 1000)
    record['events'].append(dict(atMs=record['updatedAtMs'], level='info' if played else 'warning',
                                message='设备已播放当前已是最新版本提示。' if played else '设备语音提示未播放，请以页面版本状态为准。'))
    if not played:
        record['guidance'] += '设备语音提示未播放，请以页面状态为准。'
    write(directory / 'status.json', record)
    return dict(record, **actual)


def stage(payload, check_only=False):
    validate(payload)
    actual = identity()
    if actual['cid'] != payload['cid'] or actual['deviceId'] != payload['deviceId']:
        raise ValueError('OTA_DEVICE_CHANGED: 设备身份已变化，请重新连接')
    operation = payload['operationId']
    if not re.fullmatch('[0-9a-f]{32}', operation):
        raise ValueError('OTA_OPERATION_INVALID')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (ROOT / 'lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        directory = ROOT / operation
        if directory.exists():
            saved = load(directory / 'status.json', {})
            if saved.get('state') == 'UP_TO_DATE' and load(directory / 'request.json') == payload and same_release(actual, payload):
                return dict(saved, **actual)
            raise ValueError('OTA_OPERATION_EXISTS: 请重新检查版本后再试')
        previous = current()
        if previous.get('active') or previous.get('state') == 'UNKNOWN':
            raise ValueError('OTA_ALREADY_RUNNING: 前次升级正在执行或结果待确认')
        if same_release(actual, payload):
            directory.mkdir(mode=0o700)
            return current_record(directory, payload, actual)
        if check_only:
            return read()
        if shutil.disk_usage(str(ROOT)).free < payload['size'] * 5 + 256 * 1024 * 1024:
            raise ValueError('OTA_STORAGE_UNSAFE: 升级暂存空间不足')
        directory.mkdir(mode=0o700)
        write(directory / 'request.json', payload)
        write(directory / 'status.json', dict(available=True, state='STAGING', result=None,
             operationId=operation, deviceId=actual['deviceId'], cid=actual['cid'], active=False,
             finalState=False, failureCodes=[], reason=None, events=[]))
        return dict(available=True, state='STAGING', operationId=operation, active=False,
                    finalState=False, deviceId=actual['deviceId'], cid=actual['cid'], events=[])


def validate(payload):
    if not isinstance(payload.get('size'), int) or not 0 < payload['size'] <= LIMIT:
        raise ValueError('OTA_SIZE_INVALID')
    if not re.fullmatch('[0-9a-f]{64}', payload.get('sha256', '')):
        raise ValueError('OTA_DIGEST_INVALID')


def verify(package, payload):
    validate(payload)
    if not package.is_file() or package.is_symlink() or package.stat().st_size != payload['size']:
        raise ValueError('OTA_STAGE_INCOMPLETE: SSH 安装包尚未完整传输')
    digest = hashlib.sha256()
    with package.open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != payload['sha256']:
        raise ValueError('OTA_DIGEST_MISMATCH: SSH 安装包摘要不一致')


def transfer(payload, incoming=False):
    """A per-attempt lock prevents a timed-out download racing an SSH fallback."""
    operation = payload['operationId']
    if not re.fullmatch('[0-9a-f]{32}', operation):
        raise ValueError('OTA_OPERATION_INVALID')
    validate(payload)
    directory = ROOT / operation
    if load(directory / 'request.json') != payload:
        raise ValueError('OTA_REQUEST_CHANGED')
    with (directory / 'transfer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if load(directory / 'status.json', {}).get('state') != 'STAGING':
            raise ValueError('OTA_ALREADY_SUBMITTED')
        if incoming:
            receive(payload, directory)
        else:
            download(payload, directory)
        verify(directory / 'artifact.deb', payload)
    return dict(downloaded=True)


def receive(payload, directory):
    length = 0
    with (directory / 'artifact.partial').open('wb') as target:
        while True:
            block = sys.stdin.buffer.read(1024 * 1024)
            if not block:
                break
            length += len(block)
            if length > payload['size']:
                raise ValueError('OTA_SIZE_LIMIT')
            target.write(block)
        target.flush()
        os.fsync(target.fileno())
    verify(directory / 'artifact.partial', payload)
    os.replace(str(directory / 'artifact.partial'), str(directory / 'artifact.deb'))


def launch(payload, source):
    actual = identity()
    if actual['cid'] != payload['cid'] or actual['deviceId'] != payload['deviceId']:
        raise ValueError('OTA_DEVICE_CHANGED: 设备身份已变化，请重新连接')
    operation = payload['operationId']
    if not re.fullmatch('[0-9a-f]{32}', operation):
        raise ValueError('OTA_OPERATION_INVALID')
    directory = ROOT / operation
    if not directory.is_dir():
        raise ValueError('OTA_STAGE_MISSING: 请重新传输升级包')
    with (ROOT / 'lock').open('a') as lock, (directory / 'transfer.lock').open('a') as transfer_lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(transfer_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        old = load(directory / 'status.json', {})
        if old.get('active') or old.get('state') != 'STAGING':
            # A receipt retry never launches dpkg twice.
            return old
        if load(directory / 'request.json') != payload:
            raise ValueError('OTA_REQUEST_CHANGED')
        previous = current()
        if previous.get('active') or previous.get('state') == 'UNKNOWN':
            raise ValueError('OTA_ALREADY_RUNNING: 前次升级正在执行或结果待确认')
        if same_release(actual, payload):
            return current_record(directory, payload, actual)
        package = directory / 'artifact.deb'
        verify(package, payload)
        (directory / 'worker.py').write_text(source)
        now = int(time.time() * 1000)
        record = dict(available=True, state='QUEUED', result=None, operationId=operation,
                      releaseBefore=actual['releaseId'] or actual['version'],
                      releaseTarget=payload['releaseId'], targetVersion=payload['version'],
                      deviceId=actual['deviceId'], cid=actual['cid'], active=True, finalState=False,
                      startedAtMs=now, updatedAtMs=now, failureCodes=[], reason=None, events=[])
        write(directory / 'status.json', record)
        write(ROOT / 'latest.json', dict(operationId=operation))
        result = subprocess.run(['systemd-run', '--quiet', '--unit=dohc-manager-upgrade-' + operation,
                                 '--property=Type=exec', '--property=RuntimeMaxSec=1800',
                                 '/usr/bin/python3', str(directory / 'worker.py'), 'worker'],
                                capture_output=True, timeout=12)
        if result.returncode:
            record.update(state='FAILED', result='FAIL', active=False, finalState=True,
                          reason='无法启动独立升级进程', failureCodes=['OTA_LAUNCH_FAILED'])
            write(directory / 'status.json', record)
        return record


def download(payload, directory):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    digest = hashlib.sha256()
    length = 0
    deadline = time.monotonic() + 600
    with opener.open(payload['url'], timeout=8) as response, (directory / 'artifact.partial').open('wb') as target:
        if response.status != 200:
            raise ValueError('OTA_DOWNLOAD_HTTP')
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            length += len(block)
            if length > payload['size'] or time.monotonic() > deadline:
                raise ValueError('OTA_DOWNLOAD_LIMIT')
            digest.update(block)
            target.write(block)
        target.flush()
        os.fsync(target.fileno())
    if length != payload['size'] or digest.hexdigest() != payload['sha256']:
        raise ValueError('OTA_DIGEST_MISMATCH')
    os.replace(str(directory / 'artifact.partial'), str(directory / 'artifact.deb'))


def worker(directory):
    payload = load(directory / 'request.json')
    record = load(directory / 'status.json')

    def update(state, message, level='info'):
        record.update(state=state, updatedAtMs=int(time.time() * 1000))
        record['events'] = (record['events'] + [dict(atMs=record['updatedAtMs'], level=level, message=message[:2000])])[-200:]
        write(directory / 'status.json', record)

    try:
        with (ROOT / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            update('PRECHECK', 'SSH 升级已启动；检查供电、温度、录制状态和存储。')
            power_check()
            size = payload['size']
            if not isinstance(size, int) or not 0 < size <= LIMIT:
                raise ValueError('OTA_SIZE_INVALID')
            if shutil.disk_usage(str(directory)).free < size * 5 + 256 * 1024 * 1024:
                raise ValueError('OTA_STORAGE_UNSAFE: 升级暂存空间不足')
            package = directory / 'artifact.deb'
            update('VERIFY', 'SSH 传输完成，核对完整大小、SHA-256 和 Debian 包信息。')
            verify(package, payload)

            def output(args):
                return subprocess.check_output(args, timeout=30).decode().strip()

            if output(['dpkg-deb', '-f', str(package), 'Package']) != 'd1-system':
                raise ValueError('OTA_PACKAGE_INVALID: 非 D1 系统安装包')
            if output(['dpkg-deb', '-f', str(package), 'Version']) != payload['version']:
                raise ValueError('OTA_PACKAGE_VERSION_MISMATCH')
            if output(['dpkg-deb', '-f', str(package), 'Architecture']) != output(['dpkg', '--print-architecture']):
                raise ValueError('OTA_ARCHITECTURE_MISMATCH')
            # Extract data only. Maintainer scripts are not run before validation.
            extracted = directory / 'package-data'
            subprocess.run(['dpkg-deb', '-x', str(package), str(extracted)], check=True, timeout=60)
            bundles = list((extracted / 'usr/share/d1-system').glob('*.tar.gz'))
            if len(bundles) != 1:
                raise ValueError('OTA_BUNDLE_INVALID')
            dependencies = []
            with tarfile.open(str(bundles[0])) as archive:
                for member in archive:
                    # Copy only the two known bundled dependencies; never extract arbitrary tar paths.
                    name = Path(member.name).name
                    if '/deploy/packages/' not in member.name or not name.endswith('.deb'):
                        continue
                    if not member.isfile() or member.size > 64 * 1024 * 1024 or not re.fullmatch(r'dohc-(?:base-system-tools|ffmpeg-rockchip)_[A-Za-z0-9.+:~_-]+\.deb', name):
                        raise ValueError('OTA_DEPENDENCY_INVALID')
                    target = directory / name
                    with archive.extractfile(member) as source, target.open('xb') as destination:
                        shutil.copyfileobj(source, destination, 1024 * 1024)
                    dependencies.append(str(target))
            power_check()  # Download may have taken several minutes.
            update('ACTIVATE', '正在安装随包依赖和 D1 系统；安装器执行服务切换、健康检查及失败恢复。')
            with (directory / 'install.log').open('ab') as log:
                for args in ([['dpkg', '--install'] + dependencies] if dependencies else []) + [['dpkg', '--install', str(package)]]:
                    completed = subprocess.run(args, stdout=log, stderr=log, timeout=1000,
                                               env=dict(os.environ, DEBIAN_FRONTEND='noninteractive'))
                    log.flush()
                    if completed.returncode:
                        raise ValueError('OTA_INSTALL_FAILED: dpkg 退出码 %d；详见安装日志' % completed.returncode)
            update('HEALTH_WINDOW', '安装器返回成功，核对实际运行版本和服务。')
            actual = identity()
            if actual['version'] != payload['version'] or (actual['releaseId'] and actual['releaseId'] != payload['releaseId']):
                raise ValueError('OTA_RUNNING_VERSION_MISMATCH: 实际运行版本与目标不符')
            for service in ('dohc-updater.service', 'dohc-monitor.service', 'dohc-camera.service'):
                subprocess.run(['systemctl', 'is-active', '--quiet', service], check=True, timeout=8)
            record.update(active=False, finalState=True, result='PASS')
            update('SUCCESS', '目标版本已运行，核心服务正常；SSH 升级完成。')
        # Only remove this attempt's large temporary files after confirmed success.
        try:
            package.unlink()
            shutil.rmtree(str(extracted))
            for dependency in dependencies:
                Path(dependency).unlink()
        except OSError:
            pass  # Cleanup failure cannot change the confirmed install result.
    except Exception as error:
        message = str(error)[:1600]
        code = message.partition(':')[0]
        if not re.fullmatch('OTA_[A-Z_]+', code):
            code = 'OTA_SSH_WORKER_FAILED'
        record.update(active=False, finalState=True, result='FAIL', reason=message, failureCodes=[code])
        log = directory / 'install.log'
        if log.exists():
            with log.open('rb') as handle:
                handle.seek(max(0, log.stat().st_size - 12000))
                for line in handle.read().decode(errors='replace').splitlines()[-100:]:
                    update('FAILED', line, 'error')
        update('FAILED', message, 'error')


def entry(action, payload=None, source=None):
    if action == 'read':
        result = read()
    elif action in ('stage', 'check'):
        result = stage(payload, check_only=action == 'check')
    elif action in ('download', 'receive'):
        result = transfer(payload, incoming=action == 'receive')
    elif action == 'launch':
        result = launch(payload, source)
    else:
        raise ValueError('OTA_ACTION_INVALID')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__' and sys.argv[1:] == ['worker']:
    worker(Path(__file__).parent)

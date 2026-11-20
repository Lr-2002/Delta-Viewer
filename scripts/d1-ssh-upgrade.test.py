"""Isolated device installer regression; never installs a package or contacts a device."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import hashlib

spec = importlib.util.spec_from_file_location('upgrade', Path(__file__).resolve().parents[1] / 'src-tauri/src/d1_ssh_upgrade.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'journal'
        self.patch('ROOT', self.root)
        self.identity = dict(deviceId='b18a915d-f012-4c96-8dcb-56391da07c92', cid='0123456789abcdef0123456789abcdef', version='1.1.1', releaseId='before')
        self.patch('identity', lambda: self.identity.copy())
        self.patch('config', lambda: {})
        self.report = dict(phase='IDLE', heartbeat_stale=False, power=dict(voltage=7.8, temperature=40))
        self.patch('health', lambda: self.report)
        self.announcements = []
        self.patch('announce_current', lambda: self.announcements.append('up-to-date') or True)
        self.installs = []
        self.starts = 0
        self.prompt_starts = []
        self.fail_install = False
        self.wrong_version = False
        self.run_real = subprocess.run
        self.patch('subprocess.run', self.run_command)
        self.package = self.build_package()
        raw = self.package.read_bytes()
        self.payload = dict(operationId='ab' * 16, releaseId='test-release', version='1.3.1', size=len(raw), sha256=hashlib.sha256(raw).hexdigest(), url='http://127.0.0.1/unused', deviceId=self.identity['deviceId'], cid=self.identity['cid'])

    def patch(self, name, value):
        obj, _, attr = name.rpartition('.')
        target = upgrade
        if obj:
            for part in obj.split('.'):
                target = getattr(target, part)
        p = patch.object(target, attr, value)
        p.start()
        self.addCleanup(p.stop)

    def support_archive(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            manifest = json.dumps({'schema':'dohc.device.support-bundle.v1','bundle_id':'b18a915d-f012-4c96-8dcb-56391da07c92'}).encode()
            member = tarfile.TarInfo('manifest.json')
            member.size = len(manifest)
            archive.addfile(member, io.BytesIO(manifest))
        return stream.getvalue()

    def test_support_bundle_is_bounded_device_scoped_and_deleted_only_after_download(self):
        support_root = self.base / 'support'
        self.patch('SUPPORT_ROOT', support_root)
        archive = self.support_archive()
        summary = {'schema':'dohc.device.support-bundle.v1','bundle_id':'b18a915d-f012-4c96-8dcb-56391da07c92',
                   'bytes':len(archive),'sha256':hashlib.sha256(archive).hexdigest()}
        def run(args, **kwargs):
            self.assertEqual(args[:3], ['/usr/local/bin/dci','support-bundle','--since=-30 min'])
            output = Path(args[args.index('--output')+1])
            output.write_bytes(archive)
            return types.SimpleNamespace(returncode=0,stdout=json.dumps(summary),stderr='')
        self.patch('subprocess.run',run)
        identity={'deviceId':'b18a915d-f012-4c96-8dcb-56391da07c92','cid':'0123456789abcdef0123456789abcdef'}
        prepared=upgrade.support_bundle_prepare(identity)
        transferred=upgrade.support_bundle_read(dict(identity,temporaryId=prepared['temporaryId']))
        self.assertEqual(transferred['archiveBase64'],__import__('base64').b64encode(archive).decode())
        self.assertTrue(upgrade.support_bundle_cleanup(dict(identity,temporaryId=prepared['temporaryId']))['cleaned'])
        self.assertFalse((support_root/(prepared['temporaryId']+'.tar.gz')).exists())

    def test_support_bundle_refuses_changed_identity_invalid_ids_and_expired_files(self):
        support_root=self.base/'support';self.patch('SUPPORT_ROOT',support_root)
        with self.assertRaisesRegex(ValueError,'SUPPORT_DEVICE_CHANGED'):
            upgrade.support_bundle_prepare({'deviceId':'other','cid':'0123456789abcdef0123456789abcdef'})
        support_root.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError,'SUPPORT_TEMPORARY_ID_INVALID'):
            upgrade.support_bundle_read({'deviceId':self.identity['deviceId'],'cid':self.identity['cid'],'temporaryId':'../../latest.json'})
        expired=support_root/('a'*32+'.tar.gz');expired.write_bytes(b'old')
        import os,time
        os.utime(expired,(time.time()-upgrade.SUPPORT_MAX_AGE_SECONDS-10,)*2)
        upgrade.expire_support_bundles(support_root)
        self.assertFalse(expired.exists())

    def build_package(self):
        data = self.base / 'deb'
        (data / 'DEBIAN').mkdir(parents=True)
        (data / 'DEBIAN/control').write_text('Package: d1-system\nVersion: 1.3.1\nArchitecture: ' + subprocess.check_output(['dpkg', '--print-architecture']).decode().strip() + '\nMaintainer: Test <test@example.invalid>\nDescription: isolated fixture\n')
        bundle = data / 'usr/share/d1-system/test.tar.gz'
        bundle.parent.mkdir(parents=True)
        with tarfile.open(bundle, 'w:gz') as archive:
            for name in ('dohc-base-system-tools_0.3.1-3_arm64.deb', 'dohc-ffmpeg-rockchip_8.1.2-1_arm64.deb'):
                member = tarfile.TarInfo('fixture/deploy/packages/' + name)
                member.size = 7
                archive.addfile(member, io.BytesIO(b'fixture'))
        package = self.base / 'fixture.deb'
        self.run_real(['dpkg-deb', '--build', str(data), str(package)], check=True, capture_output=True)
        return package

    def run_command(self, args, **kwargs):
        if args[0] == 'dpkg' and args[1] == '--install':
            self.installs.append(args)
            if self.fail_install:
                kwargs['stdout'].write(b'fixture install failed\n')
                return types.SimpleNamespace(returncode=1)
            if args[-1].endswith('artifact.deb') and not self.wrong_version:
                self.identity.update(version='1.3.1', releaseId='test-release')
            return types.SimpleNamespace(returncode=0)
        if args[0] == 'systemd-run' and args[-1] == 'version-prompt':
            self.prompt_starts.append(args)
            return types.SimpleNamespace(returncode=0)
        if args[0] == 'systemd-run':
            self.starts += 1
            return types.SimpleNamespace(returncode=0)
        if args[0] == 'systemctl':
            return types.SimpleNamespace(returncode=0)
        return self.run_real(args, **kwargs)

    def staged(self):
        upgrade.stage(self.payload)
        directory = self.root / self.payload['operationId']
        (directory / 'artifact.deb').write_bytes(self.package.read_bytes())
        return directory

    def launched(self):
        directory = self.staged()
        upgrade.launch(self.payload, '# isolated worker')
        return directory

    def result(self, directory):
        return upgrade.load(directory / 'status.json')

    def test_check_matching_release_announces_without_download_or_install_and_survives_read(self):
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        self.report = dict(phase='RECORDING')  # A version check does not install.
        with patch.object(upgrade, 'download', side_effect=AssertionError('must not download')):
            result = upgrade.stage(self.payload, check_only=True)
        self.assertEqual((result['state'], result['result']), ('UP_TO_DATE', 'UP_TO_DATE'))
        self.assertTrue(result['finalState'])
        self.assertFalse(result['active'])
        self.assertEqual(self.announcements, [], 'version result returns before audio')
        self.assertEqual(len(self.prompt_starts), 1)
        upgrade.prompt_worker(self.root / self.payload['operationId'])
        self.assertEqual(self.announcements, ['up-to-date'])
        self.assertEqual(self.installs, [])
        self.assertEqual(self.starts, 0)
        directory = self.root / self.payload['operationId']
        self.assertFalse((directory / 'artifact.deb').exists())
        for _ in range(3):
            self.assertEqual(upgrade.read()['state'], 'UP_TO_DATE')
        upgrade.stage(self.payload, check_only=True)  # Receipt retry is silent.
        self.assertEqual(self.announcements, ['up-to-date'])

    def test_direct_submit_same_release_skips_install_but_different_build_does_not(self):
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        self.assertEqual(upgrade.stage(self.payload)['state'], 'UP_TO_DATE')
        upgrade.prompt_worker(self.root / self.payload['operationId'])
        self.assertEqual(self.starts, 0)
        self.payload['operationId'] = 'cd' * 16
        self.payload['releaseId'] = 'same-version-new-build'
        result = upgrade.stage(self.payload, check_only=True)
        self.assertEqual(result['releaseId'], 'test-release')
        self.assertFalse((self.root / self.payload['operationId']).exists())
        self.assertEqual(upgrade.stage(self.payload)['state'], 'STAGING')
        self.assertEqual(self.announcements, ['up-to-date'])

    def test_newer_release_check_never_stages_and_audio_failure_does_not_change_version_result(self):
        result = upgrade.stage(self.payload, check_only=True)
        self.assertEqual(result['state'], 'IDLE')
        self.assertFalse((self.root / self.payload['operationId']).exists())
        self.assertEqual(self.announcements, [])
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        result = upgrade.stage(self.payload, check_only=True)
        with patch.object(upgrade, 'announce_current', return_value=False):
            upgrade.prompt_worker(self.root / self.payload['operationId'])
            result = upgrade.read()
        self.assertEqual((result['state'], result['result']), ('UP_TO_DATE', 'UP_TO_DATE'))
        self.assertEqual(result['failureCodes'], [])
        self.assertIn('语音提示未播放', result['guidance'])
        self.assertEqual(result['events'][-1]['level'], 'warning')

    def test_slow_voice_does_not_hold_version_result_or_replay_on_receipt_retry(self):
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        started, release = threading.Event(), threading.Event()
        def slow_voice():
            self.announcements.append('up-to-date')
            started.set()
            if not release.wait(3):
                raise AssertionError('fixture audio was never released')
            return True
        with patch.object(upgrade, 'announce_current', side_effect=slow_voice):
            result = upgrade.stage(self.payload, check_only=True)
            self.assertEqual((result['state'], result['audioState']), ('UP_TO_DATE', 'queued'))
            directory = self.root / self.payload['operationId']
            thread = threading.Thread(target=upgrade.prompt_worker, args=(directory,))
            thread.start()
            try:
                self.assertTrue(started.wait(1))
                self.assertEqual(upgrade.read()['state'], 'UP_TO_DATE')
                self.assertEqual(upgrade.stage(self.payload, check_only=True)['state'], 'UP_TO_DATE')
                self.assertEqual(len(self.prompt_starts), 1)
                upgrade.prompt_worker(directory)
                upgrade.prompt_start_failed(directory)
                self.assertEqual(upgrade.load(directory / 'status.json')['audioState'], 'playing')
                # A newer operation must not be replaced by late audio completion.
                upgrade.write(self.root / 'latest.json', {'operationId': 'cd' * 16})
            finally:
                release.set()
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(upgrade.load(directory / 'status.json')['audioState'], 'played')
            upgrade.prompt_start_failed(directory)
            self.assertEqual(upgrade.load(directory / 'status.json')['audioState'], 'played')
            upgrade.prompt_worker(directory)
            self.assertEqual(self.announcements, ['up-to-date'])
            self.assertEqual(upgrade.load(self.root / 'latest.json')['operationId'], 'cd' * 16)

    def test_prompt_start_failure_does_not_fail_the_verified_version(self):
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        with patch.object(upgrade.subprocess, 'run', return_value=types.SimpleNamespace(returncode=1)):
            result = upgrade.stage(self.payload, check_only=True)
        self.assertEqual((result['state'], result['result']), ('UP_TO_DATE', 'UP_TO_DATE'))
        self.assertEqual(result['failureCodes'], [])
        self.assertIn('语音提示未播放', result['guidance'])
        self.assertEqual(self.installs, [])

    def test_version_check_cannot_replace_unknown_or_active_attempt_or_other_device(self):
        directory = self.launched()
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        self.payload['operationId'] = 'cd' * 16
        with self.assertRaisesRegex(ValueError, 'OTA_ALREADY_RUNNING'):
            upgrade.stage(self.payload, check_only=True)
        self.assertEqual(self.announcements, [])
        self.payload['cid'] = 'f' * 32
        with self.assertRaisesRegex(ValueError, 'OTA_DEVICE_CHANGED'):
            upgrade.stage(self.payload, check_only=True)

    def test_version_changed_during_transfer_is_rechecked_before_launch(self):
        directory = self.staged()
        self.identity.update(version=self.payload['version'], releaseId=self.payload['releaseId'])
        result = upgrade.launch(self.payload, '# fixture')
        upgrade.prompt_worker(directory)
        self.assertEqual(result['state'], 'UP_TO_DATE')
        self.assertEqual(self.starts, 0)
        self.assertEqual(self.installs, [])
        self.assertEqual(self.announcements, ['up-to-date'])
        upgrade.launch(self.payload, '# repeated')
        self.assertEqual(self.announcements, ['up-to-date'])

    def test_success_uses_bundled_dependencies_then_package_and_confirms_version(self):
        directory = self.launched()
        upgrade.worker(directory)
        result = self.result(directory)
        self.assertEqual((result['state'], result['result']), ('SUCCESS', 'PASS'))
        self.assertEqual(len(self.installs), 2)
        self.assertEqual(len(self.installs[0]), 4)
        self.assertTrue(self.installs[1][-1].endswith('artifact.deb'))
        self.assertFalse((directory / 'artifact.deb').exists())

    def test_package_modified_after_launch_never_installs(self):
        directory = self.launched()
        package = directory / 'artifact.deb'
        raw = bytearray(package.read_bytes())
        raw[-1] ^= 1
        package.write_bytes(raw)
        upgrade.worker(directory)
        self.assertEqual(self.installs, [])
        self.assertEqual(self.result(directory)['failureCodes'], ['OTA_DIGEST_MISMATCH'])

    def test_low_voltage_high_temperature_and_busy_never_install(self):
        for report, code in [(dict(phase='IDLE', power=dict(voltage=7.2, temperature=40)), 'OTA_POWER_UNSAFE'), (dict(phase='IDLE', power=dict(voltage=8, temperature=75)), 'OTA_TEMPERATURE_UNSAFE'), (dict(phase='RECORDING'), 'OTA_DEVICE_BUSY'), (dict(phase='IDLE', heartbeat_stale=True), 'OTA_HEALTH_STALE')]:
            self.payload['operationId'] = hashlib.md5(code.encode()).hexdigest()
            directory = self.launched()
            self.report = report
            upgrade.worker(directory)
            self.assertEqual(self.result(directory)['failureCodes'], [code])
        self.assertEqual(self.installs, [])

    def test_recording_writer_self_test_and_missing_components_block_install(self):
        for extra, code in [(dict(can_stop=True), 'OTA_DEVICE_BUSY'),
                            (dict(recording=dict(session='active')), 'OTA_DEVICE_BUSY'),
                            (dict(writer=dict(queue_depth=1)), 'OTA_WRITER_BUSY'),
                            (dict(self_test=dict(phase='RUNNING')), 'OTA_DEVICE_BUSY'),
                            (dict(missing_required=['camera']), 'OTA_REQUIRED_COMPONENT_MISSING')]:
            self.report = dict(phase='IDLE', power=dict(voltage=8, temperature=40), **extra)
            with self.assertRaisesRegex(ValueError, code):
                upgrade.power_check()

    def test_storage_only_fault_matches_existing_updater_exception(self):
        self.report.update(phase='FAULT', health='FAILED', storage=dict(writable=False),
                           alerts=[dict(severity='critical', component='storage.sd')], can_start=False)
        upgrade.power_check()
        self.report['alerts'].append(dict(severity='critical', component='camera'))
        with self.assertRaisesRegex(ValueError, 'OTA_DEVICE_BUSY'):
            upgrade.power_check()

    def test_failed_dpkg_and_wrong_running_version_cannot_report_success(self):
        directory = self.launched()
        self.fail_install = True
        upgrade.worker(directory)
        result = self.result(directory)
        self.assertEqual(result['failureCodes'], ['OTA_INSTALL_FAILED'])
        self.assertTrue(any('fixture install failed' in x['message'] for x in result['events']))
        self.fail_install = False
        self.wrong_version = True
        self.payload['operationId'] = 'cd' * 16
        directory = self.launched()
        upgrade.worker(directory)
        self.assertEqual(self.result(directory)['failureCodes'], ['OTA_RUNNING_VERSION_MISMATCH'])

    def test_launch_receipt_retry_does_not_run_installer_twice(self):
        directory = self.launched()
        upgrade.launch(self.payload, '# repeated')
        self.assertEqual(self.starts, 1)
        upgrade.worker(directory)
        upgrade.launch(self.payload, '# repeated after completion')
        self.assertEqual(self.starts, 1)
        self.assertEqual(len(self.installs), 2)

    def test_receive_truncated_or_different_bytes_never_promotes_partial(self):
        directory = self.staged()
        (directory / 'artifact.deb').unlink()
        for raw in (b'truncated', b'x' * self.payload['size']):
            with patch.object(upgrade.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(raw))):
                with self.assertRaises(ValueError):
                    upgrade.transfer(self.payload, incoming=True)
            self.assertFalse((directory / 'artifact.deb').exists())
        with patch.object(upgrade.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(self.package.read_bytes()))):
            upgrade.transfer(self.payload, incoming=True)
        self.assertEqual((directory / 'artifact.deb').read_bytes(), self.package.read_bytes())

    def test_unknown_worker_result_blocks_another_attempt(self):
        directory = self.launched()
        record = self.result(directory)
        record['updatedAtMs'] = 1
        upgrade.write(directory / 'status.json', record)
        with patch.object(upgrade.subprocess, 'run', return_value=types.SimpleNamespace(returncode=3)):
            self.assertEqual(upgrade.current()['state'], 'UNKNOWN')
            self.payload['operationId'] = 'ef' * 16
            with self.assertRaisesRegex(ValueError, 'OTA_ALREADY_RUNNING'):
                upgrade.stage(self.payload)

    def test_bad_size_and_changed_identity_rejected_before_staging(self):
        self.payload['size'] = upgrade.LIMIT + 1
        with self.assertRaisesRegex(ValueError, 'OTA_SIZE_INVALID'):
            upgrade.stage(self.payload)
        self.payload['size'] = self.package.stat().st_size
        self.payload['cid'] = 'f' * 32
        with self.assertRaisesRegex(ValueError, 'OTA_DEVICE_CHANGED'):
            upgrade.stage(self.payload)
        self.assertFalse(self.root.exists())


if __name__ == '__main__':
    unittest.main()

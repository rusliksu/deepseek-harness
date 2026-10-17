"""Project the recorded account cancellation through the real Python SDK."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'apps' / 'cli' / 'lib' / 'bin.js'


@pytest.mark.skipif(not CLI.exists(), reason='requires the built dsh profile runtime')
def test_account_provider_signout_snapshot(tmp_path: Path) -> None:
    node = shutil.which('node')
    assert node is not None, 'the built JavaScript CLI requires Node'
    patch = ROOT / 'snapshots' / 'sdk' / 'account-provider-signout' / 'cordis.yml'
    with DeepSeekHarness(
        _launch_args=(node, str(CLI), '--profile', 'sdk', '--patch', str(patch)),
        dsh_home=str(tmp_path / 'home'),
        cwd=str(tmp_path),
        profile='sdk',
        patches=(str(ROOT / 'snapshots' / 'sdk' / 'account-provider-signout' / 'cordis.yml'),),
        provider='deepseek-account',
        model='deepseek-v4-flash',
        env={'DSH_HOME': str(tmp_path / 'home'), 'DSH_TELEMETRY_DISABLED': '1', 'DSH_SNAPSHOT': 'replay'},
    ) as harness:
        result = harness.run('Reply with exactly: SDK snapshot')
    ending = next(event for event in reversed(result.events) if event['type'] == 'turn/end')
    status = next(notification for notification in reversed(result.notifications)
                  if notification.method == 'session.status' and notification.payload['sessionId'] == result.session_id)
    actual = {
        'final_response': result.final_response,
        'finish_reason': result.finish_reason,
        'reason': ending['data']['reason'],
        'status': status.payload['status'],
    }
    expected = Path(__file__).with_name('expected') / 'account-provider-signout.json'
    assert actual == json.loads(expected.read_text())

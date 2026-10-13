/**
 * Windows ProgramData inheritance regression (#702 / #627):
 * a host may omit ProgramData before starting Desktop Commander. Child shells
 * and native Windows OpenSSH must still receive a usable value.
 *
 * Unit cases also run on non-Windows hosts using plain environment objects.
 * The real child-process/OpenSSH check runs only on Windows.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as terminal from '../dist/terminal-manager.js';
import { runIfMain, skip } from './helpers/run-if-main.js';

function testProgramDataRepair() {
  const repair = terminal.repairWindowsProgramData;
  assert.equal(typeof repair, 'function', 'export a testable Windows ProgramData repair helper');
  const cases = [
    ['preserves a custom path', { ProgramData: 'D:\\CustomData', SystemDrive: 'C:', EXTRA: 'kept' },
      { ProgramData: 'D:\\CustomData', SystemDrive: 'C:', EXTRA: 'kept' }],
    ['preserves alternate case', { PROGRAMDATA: 'E:\\Shared' }, { PROGRAMDATA: 'E:\\Shared' }],
    ['uses SystemDrive', { SystemDrive: 'D:', EXTRA: 'kept' },
      { SystemDrive: 'D:', EXTRA: 'kept', ProgramData: 'D:\\ProgramData' }],
    ['accepts uppercase SYSTEMDRIVE', { SYSTEMDRIVE: 'E:' },
      { SYSTEMDRIVE: 'E:', ProgramData: 'E:\\ProgramData' }],
    ['uses C drive when SystemDrive is absent', { EXTRA: 'kept' },
      { EXTRA: 'kept', ProgramData: 'C:\\ProgramData' }],
    ['ignores an invalid SystemDrive', { SystemDrive: 'not-a-drive' },
      { SystemDrive: 'not-a-drive', ProgramData: 'C:\\ProgramData' }],
    ['repairs an empty value', { ProgramData: '', SystemDrive: 'F:' },
      { ProgramData: 'F:\\ProgramData', SystemDrive: 'F:' }],
    ['removes empty duplicate casing', { PROGRAMDATA: '', ProgramData: 'Q:\\Custom' },
      { ProgramData: 'Q:\\Custom' }],
  ];
  for (const [name, given, expected] of cases) {
    repair(given);
    assert.deepEqual(given, expected, name);
    repair(given);
    assert.deepEqual(given, expected, `${name} (idempotent)`);
  }
}

async function testRealWindowsSpawn() {
  if (process.platform !== 'win32') {
    skip('ProgramData + Windows OpenSSH integration requires Windows');
    return;
  }
  const previous = Object.entries(process.env)
    .filter(([key]) => key.toLowerCase() === 'programdata');
  try {
    // This changes only the isolated test runner's own environment.
    for (const [key] of previous) delete process.env[key];
    const probe = await terminal.terminalManager.executeCommand(
      'Write-Output "DC_PROGRAMDATA=$env:ProgramData"', 10000, 'powershell.exe');
    assert.match(probe.output, /DC_PROGRAMDATA=[A-Z]:\\ProgramData/i,
      `start_process child must get repaired ProgramData; output: ${JSON.stringify(probe.output)}`);
    const cmdProbe = await terminal.terminalManager.executeCommand(
      'echo DC_CMD_PROGRAMDATA=%ProgramData%', 10000, 'cmd.exe');
    assert.match(cmdProbe.output, /DC_CMD_PROGRAMDATA=[A-Z]:\\ProgramData/i,
      `cmd.exe child must also receive ProgramData: ${JSON.stringify(cmdProbe.output)}`);
    const sshExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (!fs.existsSync(sshExe)) {
      skip('Windows OpenSSH is not installed at the system path');
      return;
    }
    const command = `& "${sshExe}" -V; Write-Output "DC_SSH_EXIT=$LASTEXITCODE"`;
    const ssh = await terminal.terminalManager.executeCommand(command, 10000, 'powershell.exe');
    assert.match(ssh.output, /DC_SSH_EXIT=0/,
      `Windows OpenSSH should no longer silently exit 255: ${JSON.stringify(ssh.output)}`);

    // These invocations intentionally ask for usage/error output, not network
    // transfers, key modification, or an agent connection.
    for (const [name, args] of [
      ['scp.exe', ''], ['sftp.exe', ''], ['ssh-keygen.exe', '-?'],
      ['ssh-add.exe', '-?'], ['ssh-keyscan.exe', '-?'],
    ]) {
      const executable = path.join(path.dirname(sshExe), name);
      if (!fs.existsSync(executable)) {
        skip(`${name} is not installed at the system path`);
        continue;
      }
      const result = await terminal.terminalManager.executeCommand(
        `& "${executable}" ${args}; Write-Output "DC_NATIVE_EXIT=$LASTEXITCODE"`,
        10000, 'powershell.exe');
      const exit = result.output.match(/DC_NATIVE_EXIT=(\d+)/);
      assert.ok(exit && exit[1] !== '255',
        `${name} must not silently exit 255: ${JSON.stringify(result.output)}`);
      assert.ok(result.output.replace(/DC_NATIVE_EXIT=\d+/, '').trim(),
        `${name} should produce its normal usage/error message`);
    }
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toLowerCase() === 'programdata') delete process.env[key];
    }
    for (const [key, value] of previous) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

async function runTests() {
  let failed = 0;
  for (const [name, test] of [
    ['real Windows child-process inheritance', testRealWindowsSpawn],
    ['ProgramData repair unit cases', testProgramDataRepair],
  ]) {
    try {
      await test();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL: ${name}`, error);
    }
  }
  return failed === 0;
}

runIfMain(import.meta.url, runTests);
export default runTests;

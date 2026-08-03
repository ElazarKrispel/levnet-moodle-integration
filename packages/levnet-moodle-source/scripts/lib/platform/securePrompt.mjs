import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runSecureDialog({ title, prompt, defaultValue = "", hidden = false, platform = process.platform }) {
  if (platform === "darwin") return runMacDialog({ title, prompt, defaultValue, hidden });
  if (platform === "win32") return runWindowsDialog({ title, prompt, defaultValue, hidden });
  if (platform === "linux") return runLinuxDialog({ title, prompt, defaultValue, hidden });
  throw new Error(`Levnet & Moodle Integration secure prompts are not supported on platform ${platform}.`);
}

export async function showSecretCopyDialog({
  title,
  prompt,
  secret,
  platform = process.platform,
}) {
  if (!secret) throw new Error("A secret value is required for the copy dialog.");
  if (platform === "darwin") return runMacCopyDialog({ title, prompt, secret });
  if (platform === "win32") return runWindowsCopyDialog({ title, prompt, secret });
  if (platform === "linux") return runLinuxCopyDialog({ title, prompt, secret });
  throw new Error(`Levnet & Moodle Integration secure copy dialogs are not supported on platform ${platform}.`);
}

export function normalizeBase32(value) {
  const cleaned = String(value ?? "").replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  return cleaned && /^[A-Z2-7]+$/.test(cleaned) ? cleaned : null;
}

async function runMacDialog({ title, prompt, defaultValue, hidden }) {
  const script = `display dialog "${escapeAppleScript(prompt)}" default answer "${escapeAppleScript(defaultValue)}" with title "${escapeAppleScript(title)}" buttons {"Cancel", "OK"} default button "OK"${hidden ? " with hidden answer" : ""}`;
  const { stdout } = await execFileAsync("osascript", ["-e", script], dialogOptions());
  const match = stdout.match(/text returned:([\s\S]*)$/);
  return (match ? match[1] : stdout).replace(/[\r\n]+$/, "");
}

async function runMacCopyDialog({ title, prompt, secret }) {
  const script = `
set secretValue to system attribute "LMI_DIALOG_SECRET"
display dialog "${escapeAppleScript(prompt)}" with title "${escapeAppleScript(title)}" buttons {"Cancel", "Copy"} default button "Copy"
set the clipboard to secretValue
return "copied"
`;
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    ...dialogOptions(),
    env: { ...process.env, LMI_DIALOG_SECRET: secret },
  });
  return { copied: stdout.trim() === "copied", shown: true };
}

async function runWindowsDialog({ title, prompt, defaultValue, hidden }) {
  const command = await findPowerShell();
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = $env:LMI_DIALOG_TITLE
$form.Size = New-Object Drawing.Size(620,270)
$form.StartPosition = 'CenterScreen'
$label = New-Object Windows.Forms.Label
$label.Text = $env:LMI_DIALOG_PROMPT
$label.Location = New-Object Drawing.Point(15,15)
$label.Size = New-Object Drawing.Size(575,125)
$box = New-Object Windows.Forms.TextBox
$box.Location = New-Object Drawing.Point(15,150)
$box.Size = New-Object Drawing.Size(575,25)
$box.Text = $env:LMI_DIALOG_DEFAULT
$box.UseSystemPasswordChar = ($env:LMI_DIALOG_HIDDEN -eq '1')
$ok = New-Object Windows.Forms.Button
$ok.Text = 'אישור'; $ok.Location = New-Object Drawing.Point(425,190); $ok.DialogResult = 'OK'
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'ביטול'; $cancel.Location = New-Object Drawing.Point(510,190); $cancel.DialogResult = 'Cancel'
$form.Controls.AddRange(@($label,$box,$ok,$cancel)); $form.AcceptButton = $ok; $form.CancelButton = $cancel
$form.Add_Shown({$box.Select()})
if ($form.ShowDialog() -ne 'OK') { exit 2 }
[Console]::Out.Write($box.Text)
`;
  const { stdout } = await execFileAsync(command, ["-NoProfile", "-STA", "-Command", script], {
    ...dialogOptions(), env: {
      ...process.env, LMI_DIALOG_TITLE: title, LMI_DIALOG_PROMPT: prompt,
      LMI_DIALOG_DEFAULT: defaultValue, LMI_DIALOG_HIDDEN: hidden ? "1" : "0",
    },
  });
  return stdout;
}

async function runWindowsCopyDialog({ title, prompt, secret }) {
  const command = await findPowerShell();
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = $env:LMI_DIALOG_TITLE
$form.Size = New-Object Drawing.Size(620,235)
$form.StartPosition = 'CenterScreen'
$label = New-Object Windows.Forms.Label
$label.Text = $env:LMI_DIALOG_PROMPT
$label.Location = New-Object Drawing.Point(15,15)
$label.Size = New-Object Drawing.Size(575,115)
$copy = New-Object Windows.Forms.Button
$copy.Text = 'Copy and continue'
$copy.Location = New-Object Drawing.Point(345,145)
$copy.Size = New-Object Drawing.Size(150,32)
$copy.Add_Click({
  [Windows.Forms.Clipboard]::SetText($env:LMI_DIALOG_SECRET)
  $form.Tag = 'copied'
  $form.Close()
})
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object Drawing.Point(505,145)
$cancel.Size = New-Object Drawing.Size(85,32)
$cancel.Add_Click({ $form.Tag = 'cancelled'; $form.Close() })
$form.Controls.AddRange(@($label,$copy,$cancel))
$form.AcceptButton = $copy
$form.CancelButton = $cancel
$form.Add_Shown({$copy.Select()})
[void]$form.ShowDialog()
if ($form.Tag -eq 'copied') { [Console]::Out.Write('copied'); exit 0 }
exit 2
`;
  const { stdout } = await execFileAsync(command, ["-NoProfile", "-STA", "-Command", script], {
    ...dialogOptions(),
    env: {
      ...process.env,
      LMI_DIALOG_TITLE: title,
      LMI_DIALOG_PROMPT: prompt,
      LMI_DIALOG_SECRET: secret,
    },
  });
  return { copied: stdout === "copied", shown: true };
}

async function runLinuxDialog({ title, prompt, defaultValue, hidden }) {
  const args = ["--entry", "--title", title, "--text", prompt, "--entry-text", defaultValue];
  if (hidden) args.push("--hide-text");
  try {
    const { stdout } = await execFileAsync("zenity", args, dialogOptions());
    return stdout.replace(/[\r\n]+$/, "");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Install zenity to use JCT secure setup dialogs on Linux.");
    throw error;
  }
}

async function runLinuxCopyDialog({ title, prompt, secret }) {
  try {
    await execFileAsync("zenity", [
      "--question",
      "--title", title,
      "--text", prompt,
      "--ok-label", "Copy and continue",
      "--cancel-label", "Cancel",
    ], dialogOptions());
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("Install zenity to use JCT secure setup dialogs on Linux.");
    throw error;
  }

  for (const candidate of [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]) {
    try {
      await writeToProcess(candidate.command, candidate.args, secret);
      return { copied: true, shown: true };
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }

  await runLinuxDialog({ title, prompt: `${prompt}\n\nCopy the link from the field below.`, defaultValue: secret, hidden: false });
  return { copied: false, shown: true, manualCopyRequired: true };
}

async function writeToProcess(command, args, value) {
  const { spawn } = await import("node:child_process");
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
    child.stdin.end(value);
  });
}

async function findPowerShell() {
  for (const command of ["powershell.exe", "pwsh.exe", "pwsh"]) {
    try {
      await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command]);
      return command;
    } catch {}
  }
  throw new Error("PowerShell is required for Levnet & Moodle Integration secure setup dialogs on Windows.");
}

function dialogOptions() {
  return { timeout: 600000, maxBuffer: 1024 * 1024 };
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

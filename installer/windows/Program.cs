using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;

namespace LevnetMoodleInstaller;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
        {
            var testRoot = Path.Combine(Path.GetTempPath(), "LevnetMoodleInstallerTest-" + Guid.NewGuid().ToString("N"));
            try
            {
                var marketplace = InstallerForm.InstallPayload(testRoot);
                return File.Exists(marketplace) ? 0 : 1;
            }
            catch
            {
                return 1;
            }
            finally
            {
                if (Directory.Exists(testRoot)) Directory.Delete(testRoot, true);
            }
        }
        ApplicationConfiguration.Initialize();
        Application.Run(new InstallerForm());
        return 0;
    }
}

internal sealed class InstallerForm : Form
{
    private const string Version = "2.0.1";
    private readonly Button installButton = new();
    private readonly Label statusLabel = new();
    private readonly ProgressBar progress = new();
    private string? marketplacePath;

    internal InstallerForm()
    {
        Text = "Levnet & Moodle Integration";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 445);
        MinimumSize = new Size(560, 420);
        BackColor = Color.FromArgb(246, 249, 253);
        Font = new Font("Segoe UI", 10F);
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;

        var header = new Panel { Dock = DockStyle.Top, Height = 116, BackColor = Color.FromArgb(31, 77, 183) };
        var title = new Label
        {
            Text = "Levnet & Moodle Integration",
            ForeColor = Color.White,
            Font = new Font("Segoe UI", 22F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(28, 22)
        };
        var subtitle = new Label
        {
            Text = "התקנה אישית ל־Windows ול־Codex",
            ForeColor = Color.FromArgb(221, 232, 255),
            Font = new Font("Segoe UI", 11F),
            AutoSize = true,
            Location = new Point(31, 69)
        };
        header.Controls.Add(title);
        header.Controls.Add(subtitle);

        var intro = new Label
        {
            Text = "המתקין יוסיף את הפלאגין לחשבון Windows שלך ויפתח את Codex בעמוד ההתקנה.\nלא נדרשות הרשאות מנהל, וסיסמאות אינן נשמרות במתקין.",
            AutoSize = false,
            Size = new Size(558, 65),
            Location = new Point(31, 145),
            ForeColor = Color.FromArgb(46, 61, 80)
        };
        var bullets = new Label
        {
            Text = "✓ חיבור מאובטח ל־Moodle ול־Levnet\n✓ סנכרון הגשות יומי ל־Google Calendar\n✓ חלונות מקומיים מוגנים להזנת פרטים",
            AutoSize = false,
            Size = new Size(558, 88),
            Location = new Point(31, 211),
            ForeColor = Color.FromArgb(24, 100, 83),
            Font = new Font("Segoe UI", 10.5F)
        };
        statusLabel.Text = "מוכן להתקנה";
        statusLabel.AutoSize = false;
        statusLabel.TextAlign = ContentAlignment.MiddleRight;
        statusLabel.Size = new Size(558, 26);
        statusLabel.Location = new Point(31, 307);
        statusLabel.ForeColor = Color.FromArgb(91, 106, 125);

        progress.Location = new Point(31, 337);
        progress.Size = new Size(558, 8);
        progress.Style = ProgressBarStyle.Marquee;
        progress.Visible = false;

        installButton.Text = "התקן ופתח את Codex";
        installButton.Size = new Size(220, 48);
        installButton.Location = new Point(369, 367);
        installButton.BackColor = Color.FromArgb(36, 87, 214);
        installButton.ForeColor = Color.White;
        installButton.FlatStyle = FlatStyle.Flat;
        installButton.FlatAppearance.BorderSize = 0;
        installButton.Font = new Font("Segoe UI", 10.5F, FontStyle.Bold);
        installButton.Click += InstallButton_Click;

        var closeButton = new Button
        {
            Text = "סגור",
            Size = new Size(105, 48),
            Location = new Point(250, 367),
            FlatStyle = FlatStyle.Flat,
            ForeColor = Color.FromArgb(55, 70, 90)
        };
        closeButton.Click += (_, _) => Close();

        Controls.Add(header);
        Controls.Add(intro);
        Controls.Add(bullets);
        Controls.Add(statusLabel);
        Controls.Add(progress);
        Controls.Add(installButton);
        Controls.Add(closeButton);
        AcceptButton = installButton;
    }

    private async void InstallButton_Click(object? sender, EventArgs e)
    {
        if (marketplacePath is not null)
        {
            OpenCodex(marketplacePath);
            return;
        }

        installButton.Enabled = false;
        progress.Visible = true;
        statusLabel.Text = "מתקין את הרכיבים האישיים…";
        try
        {
            marketplacePath = await Task.Run(() => InstallPayload());
            progress.Visible = false;
            statusLabel.Text = "ההתקנה המקומית הושלמה. כעת מאשרים את הפלאגין בתוך Codex.";
            statusLabel.ForeColor = Color.FromArgb(8, 127, 91);
            installButton.Text = "פתח את Codex";
            installButton.Enabled = true;
            OpenCodex(marketplacePath);
        }
        catch (Exception error)
        {
            progress.Visible = false;
            statusLabel.Text = "ההתקנה נכשלה: " + error.Message;
            statusLabel.ForeColor = Color.FromArgb(180, 35, 24);
            installButton.Text = "נסה שוב";
            installButton.Enabled = true;
        }
    }

    internal static string InstallPayload(string? productRootOverride = null)
    {
        var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var productRoot = Path.GetFullPath(productRootOverride ?? Path.Combine(localData, "LevnetMoodleIntegration"));
        var destination = Path.GetFullPath(Path.Combine(productRoot, Version));
        var staging = Path.GetFullPath(Path.Combine(productRoot, Version + ".installing"));
        Directory.CreateDirectory(productRoot);
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        Directory.CreateDirectory(staging);

        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("LevnetMoodleInstaller.payload.zip")
            ?? throw new InvalidOperationException("חבילת ההתקנה חסרה.");
        using var archive = new ZipArchive(resource, ZipArchiveMode.Read);
        foreach (var entry in archive.Entries)
        {
            var target = Path.GetFullPath(Path.Combine(staging, entry.FullName));
            if (!target.StartsWith(staging + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("חבילת ההתקנה אינה תקינה.");
            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, true);
        }

        var marketplace = Path.Combine(staging, "marketplace.json");
        var server = Path.Combine(staging, "plugins", "levnet-moodle-integration", "bin", "levnet-moodle-integration-win-x64.exe");
        if (!File.Exists(marketplace) || !File.Exists(server))
            throw new InvalidOperationException("חבילת ההתקנה אינה שלמה.");

        using (var document = JsonDocument.Parse(File.ReadAllText(marketplace)))
        {
            var entry = document.RootElement.GetProperty("plugins")[0];
            var sourcePath = entry.GetProperty("source").GetProperty("path").GetString()
                ?? throw new InvalidOperationException("Marketplace source path is missing.");
            var resolvedPlugin = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(marketplace)!, sourcePath));
            var expectedPlugin = Path.GetFullPath(Path.Combine(staging, "plugins", "levnet-moodle-integration"));
            if (!string.Equals(resolvedPlugin, expectedPlugin, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(resolvedPlugin))
                throw new InvalidOperationException("Marketplace plugin path is invalid.");
        }

        if (Directory.Exists(destination)) Directory.Delete(destination, true);
        Directory.Move(staging, destination);
        return Path.Combine(destination, "marketplace.json");
    }

    private static void OpenCodex(string path)
    {
        var link = "codex://plugins/levnet-moodle-integration?marketplacePath=" + Uri.EscapeDataString(path);
        try
        {
            Process.Start(new ProcessStartInfo(link) { UseShellExecute = true });
        }
        catch
        {
            Clipboard.SetText(link);
            MessageBox.Show("לא הצלחתי לפתוח את Codex אוטומטית. קישור ההתקנה הועתק ללוח.", "Levnet & Moodle Integration", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
    }
}

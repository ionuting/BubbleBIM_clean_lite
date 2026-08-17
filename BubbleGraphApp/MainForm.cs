using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace BubbleGraphApp;

/// <summary>
/// Main application window.
/// Hosts the React/Vite UI via Microsoft WebView2 and starts the Python FastAPI
/// backend as a child process.  Save / Open dialogs are handled natively here
/// and exposed to the renderer through a window.electronAPI-compatible bridge
/// that is injected before the page loads.
/// </summary>
public class MainForm : Form
{
    // ─── Fields ───────────────────────────────────────────────────────────

    private readonly WebView2 webView = new() { Dock = DockStyle.Fill };
    private Process?           backendProcess;
    private string?            currentFilePath;
    // HttpClient used to proxy /api/* requests to the Python backend (avoids CORS)
    private static readonly HttpClient ApiClient = new() { Timeout = TimeSpan.FromSeconds(30) };

    private const int BackendPort  = 8000;
    private const string VirtualHost = "app.bubblegraph.local";
    private const string BackendBase  = "http://localhost:8000";

    // ─── Constructor ──────────────────────────────────────────────────────

    public MainForm()
    {
        Text            = "BubbleGraph";
        Size            = new Size(1600, 960);
        MinimumSize     = new Size(1024, 600);
        StartPosition   = FormStartPosition.CenterScreen;
        BackColor       = Color.FromArgb(15, 15, 15);

        Controls.Add(webView);
        BuildNativeMenu();

        Load         += OnLoadAsync;
        FormClosing  += OnClosing;
    }

    // ─── Startup ──────────────────────────────────────────────────────────

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        StartBackend();

        // Initialize WebView2 with a custom user-data folder next to the exe
        var userDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "BubbleGraph", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
        await webView.EnsureCoreWebView2Async(env);

        var wv = webView.CoreWebView2;

        // Map the built dist/ folder to a virtual hostname (no HTTP server needed)
        var distPath = FindPath("dist");
        if (distPath != null)
        {
            wv.SetVirtualHostNameToFolderMapping(
                VirtualHost,
                distPath,
                CoreWebView2HostResourceAccessKind.Allow);
        }

        // Proxy all /api/* requests to the Python backend (same-origin, no CORS needed)
        wv.AddWebResourceRequestedFilter(
            $"https://{VirtualHost}/api/*",
            CoreWebView2WebResourceContext.All);
        wv.WebResourceRequested += OnApiProxyRequest;

        // Inject the window.electronAPI-compatible bridge before any page script runs
        await wv.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);

        // Handle messages sent from JS via window.chrome.webview.postMessage(...)
        wv.WebMessageReceived += OnWebMessageReceived;

        // Dev: connect to Vite server.  Production: serve from virtual host.
        bool isDev = distPath == null
            || Environment.GetEnvironmentVariable("BUBBLEGRAPH_DEV") == "1";

        wv.Navigate(isDev
            ? "http://localhost:3100"
            : $"https://{VirtualHost}/index.html");

#if DEBUG
        wv.OpenDevToolsWindow();
#endif
    }

    // ─── Python backend ────────────────────────────────────────────────────

    private void StartBackend()
    {
        var backendDir = FindPath("backend");
        if (backendDir == null) return;

        var mainPy = Path.Combine(backendDir, "main.py");
        if (!File.Exists(mainPy)) return;

        backendProcess = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName               = "python",
                Arguments              = "main.py",
                WorkingDirectory       = backendDir,
                UseShellExecute        = false,
                CreateNoWindow         = true,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                Environment            =
                {
                    ["PYTHONIOENCODING"]   = "utf-8",
                    ["PYTHONUNBUFFERED"]   = "1",
                },
            },
        };
        backendProcess.OutputDataReceived += (_, a) => { if (a.Data != null) Debug.WriteLine($"[py] {a.Data}"); };
        backendProcess.ErrorDataReceived  += (_, a) => { if (a.Data != null) Debug.WriteLine($"[py:err] {a.Data}"); };
        backendProcess.Start();
        backendProcess.BeginOutputReadLine();
        backendProcess.BeginErrorReadLine();
    }

    // ─── API proxy ────────────────────────────────────────────────────────────
    // Intercepts requests to https://app.bubblegraph.local/api/* and proxies
    // them to http://localhost:8000/api/* so no CORS headers are needed.

    private async void OnApiProxyRequest(object? sender,
        CoreWebView2WebResourceRequestedEventArgs e)
    {   
        // GetDeferral keeps the WebView2 event open until we call Complete()
        var deferral = e.GetDeferral();
        try
        {
            var req  = e.Request;
            var uri  = new Uri(req.Uri);
            // Rebuild target URL: replace virtual host with localhost:8000
            var target = $"{BackendBase}{uri.PathAndQuery}";

            using var hReq = new HttpRequestMessage(
                new HttpMethod(req.Method), target);

            // Forward request headers (skip Host — HttpClient sets it)
            foreach (var kv in req.Headers)
                if (!string.Equals(kv.Key, "Host",
                    StringComparison.OrdinalIgnoreCase))
                    hReq.Headers.TryAddWithoutValidation(kv.Key, kv.Value);

            // Forward request body if present
            if (req.Content is { } content)
            {
                var ms = new MemoryStream();
                content.CopyTo(ms);
                ms.Seek(0, SeekOrigin.Begin);
                hReq.Content = new StreamContent(ms);
                // Copy Content-Type
                var ct = req.Headers.FirstOrDefault(
                    kv => kv.Key.Equals("Content-Type",
                        StringComparison.OrdinalIgnoreCase)).Value;
                if (ct != null)
                    hReq.Content.Headers.TryAddWithoutValidation("Content-Type", ct);
            }

            var hResp = await ApiClient.SendAsync(hReq,
                HttpCompletionOption.ResponseHeadersRead);

            // Build response headers string for WebView2
            var headers = new System.Text.StringBuilder();
            foreach (var kv in hResp.Headers)
                foreach (var v in kv.Value)
                    headers.AppendLine($"{kv.Key}: {v}");
            foreach (var kv in hResp.Content.Headers)
                foreach (var v in kv.Value)
                    headers.AppendLine($"{kv.Key}: {v}");

            var body  = await hResp.Content.ReadAsStreamAsync();
            var wv    = webView.CoreWebView2;
            var wvResp = wv.Environment.CreateWebResourceResponse(
                body,
                (int)hResp.StatusCode,
                hResp.ReasonPhrase ?? "OK",
                headers.ToString().TrimEnd());

            e.Response = wvResp;
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[ApiProxy] Error: {ex.Message}");
            // Return a 502 so the JS fetch rejects with a meaningful status
            e.Response = webView.CoreWebView2.Environment.CreateWebResourceResponse(
                null, 502, "Bad Gateway", string.Empty);
        }
        finally
        {
            deferral.Complete();
        }
    }

    // ─── WebView2 message handler ──────────────────────────────────────────

    private async void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            var msg  = JsonNode.Parse(e.WebMessageAsJson)!;
            var id   = msg["id"]?.GetValue<string>() ?? "";
            var type = msg["type"]?.GetValue<string>() ?? "";

            switch (type)
            {
                case "dialog:save-as":
                    await HandleDialogSaveAs(id, msg["payload"]?.GetValue<string>());
                    break;

                case "dialog:open":
                    await HandleDialogOpen(id);
                    break;

                case "file:save":
                    await HandleFileSave(id, msg["payload"]);
                    break;

                case "project:get-path":
                    await SendResponse(id, currentFilePath);
                    break;

                case "project:set-path":
                    currentFilePath = msg["payload"]?.GetValue<string>();
                    UpdateTitle();
                    break;
            }
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[WV2] Message error: {ex.Message}");
        }
    }

    // ─── Dialog helpers ────────────────────────────────────────────────────

    private async Task HandleDialogSaveAs(string id, string? defaultName)
    {
        using var dlg = new SaveFileDialog
        {
            Title    = "Save BubbleGraph Project",
            FileName = defaultName ?? "project.bgjson",
            Filter   = "BubbleGraph Project (*.bgjson)|*.bgjson|JSON (*.json)|*.json",
        };
        var ok = dlg.ShowDialog(this) == DialogResult.OK;
        await SendResponse(id, ok ? dlg.FileName : (object?)null);
    }

    private async Task HandleDialogOpen(string id)
    {
        using var dlg = new OpenFileDialog
        {
            Title  = "Open BubbleGraph Project",
            Filter = "BubbleGraph Project (*.bgjson;*.json)|*.bgjson;*.json",
        };
        if (dlg.ShowDialog(this) != DialogResult.OK)
        {
            await SendResponse(id, null);
            return;
        }
        try
        {
            var json = await File.ReadAllTextAsync(dlg.FileName);
            var data = JsonNode.Parse(json);
            await SendResponse(id, new JsonObject
            {
                ["filePath"] = dlg.FileName,
                ["data"]     = data,
            });
        }
        catch (Exception ex)
        {
            await SendResponse(id, new JsonObject { ["error"] = ex.Message });
        }
    }

    private async Task HandleFileSave(string id, JsonNode? payload)
    {
        var filePath = payload?["filePath"]?.GetValue<string>();
        var data     = payload?["data"];

        if (filePath == null || data == null)
        {
            await SendResponse(id, new JsonObject { ["error"] = "Missing filePath or data" });
            return;
        }
        try
        {
            var json = data.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
            await File.WriteAllTextAsync(filePath, json);
            currentFilePath = filePath;
            UpdateTitle();
            await SendResponse(id, new JsonObject { ["success"] = true });
        }
        catch (Exception ex)
        {
            await SendResponse(id, new JsonObject { ["error"] = ex.Message });
        }
    }

    // ─── Messaging helpers ─────────────────────────────────────────────────

    /// <summary>Sends a JSON response back to a pending JS promise.</summary>
    private async Task SendResponse(string id, object? result)
    {
        var json = JsonSerializer.Serialize(new { id, result });
        await webView.CoreWebView2.ExecuteScriptAsync($"window.__wv2HandleResponse({json})");
    }

    /// <summary>Fires a push event in the renderer (e.g. from a native menu click).</summary>
    private void SendMenuEvent(string eventName, object? detail = null)
    {
        var json = JsonSerializer.Serialize(new { @event = eventName, detail });
        _ = webView.CoreWebView2.ExecuteScriptAsync($"window.__wv2HandleEvent({json})");
    }

    // ─── Native menu bar ───────────────────────────────────────────────────

    private void BuildNativeMenu()
    {
        var strip = new MenuStrip();

        // ── File ──────────────────────────────────────────
        var file = new ToolStripMenuItem("&File");
        file.DropDownItems.AddRange(new ToolStripItem[]
        {
            MakeItem("&New",            Keys.Control | Keys.N,
                     () => SendMenuEvent("menu:new-project")),
            MakeItem("&Open…",          Keys.Control | Keys.O,
                     () => SendMenuEvent("menu:open-project")),
            new ToolStripSeparator(),
            MakeItem("&Save",           Keys.Control | Keys.S,
                     () => SendMenuEvent("menu:save-project")),
            MakeItem("Save &As…",       Keys.Control | Keys.Shift | Keys.S,
                     () => SendMenuEvent("project:request-save-as")),
            new ToolStripSeparator(),
            MakeItem("&Export IFC",     Keys.Control | Keys.E,
                     () => SendMenuEvent("menu:export-ifc")),
            new ToolStripSeparator(),
            MakeItem("E&xit",           Keys.Alt | Keys.F4,
                     () => Close()),
        });

        // ── Edit ──────────────────────────────────────────
        var edit = new ToolStripMenuItem("&Edit");
        edit.DropDownItems.AddRange(new ToolStripItem[]
        {
            MakeItem("Undo", Keys.Control | Keys.Z,
                () => webView.CoreWebView2?.ExecuteScriptAsync("document.execCommand('undo')")),
            MakeItem("Redo", Keys.Control | Keys.Y,
                () => webView.CoreWebView2?.ExecuteScriptAsync("document.execCommand('redo')")),
        });

        // ── View ──────────────────────────────────────────
        var view = new ToolStripMenuItem("&View");
        view.DropDownItems.AddRange(new ToolStripItem[]
        {
            MakeItem("Reload",       Keys.F5,             () => webView.CoreWebView2?.Reload()),
            MakeItem("Dev Tools",    Keys.F12,             () => webView.CoreWebView2?.OpenDevToolsWindow()),
            new ToolStripSeparator(),
            MakeItem("Full Screen",  Keys.F11,            ToggleFullscreen),
        });

        strip.Items.AddRange(new ToolStripItem[] { file, edit, view });
        Controls.Add(strip);
        MainMenuStrip = strip;
    }

    private static ToolStripMenuItem MakeItem(string text, Keys keys, Action onClick)
    {
        var item = new ToolStripMenuItem(text) { ShortcutKeys = keys };
        item.Click += (_, _) => onClick();
        return item;
    }

    private void ToggleFullscreen()
    {
        if (FormBorderStyle == FormBorderStyle.None)
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState     = FormWindowState.Normal;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.None;
            WindowState     = FormWindowState.Maximized;
        }
    }

    // ─── Title bar ─────────────────────────────────────────────────────────

    private void UpdateTitle()
    {
        var fileName = currentFilePath != null
            ? Path.GetFileName(currentFilePath)
            : "Untitled";
        Text = $"BubbleGraph — {fileName}";
    }

    // ─── Path resolver ─────────────────────────────────────────────────────

    /// <summary>Walks up the directory tree to find a named subfolder.</summary>
    private static string? FindPath(string folderName)
    {
        var dir = Path.GetDirectoryName(AppContext.BaseDirectory) ?? AppContext.BaseDirectory;
        for (int i = 0; i < 8; i++)
        {
            var candidate = Path.Combine(dir, folderName);
            if (Directory.Exists(candidate)) return Path.GetFullPath(candidate);
            var parent = Path.GetDirectoryName(dir);
            if (parent == null || parent == dir) break;
            dir = parent;
        }
        return null;
    }

    // ─── Cleanup ───────────────────────────────────────────────────────────

    private void OnClosing(object? sender, FormClosingEventArgs e)
    {
        try { backendProcess?.Kill(entireProcessTree: true); } catch { }
    }

    // ─── WebView2 bridge script ─────────────────────────────────────────────
    //
    // Injected into every page before document creation.
    // Exposes window.electronAPI so the React app doesn't need to know
    // whether it's running inside Electron or WebView2.

    private const string BridgeScript = """
        (function () {
            'use strict';

            const pending = Object.create(null);
            let _seq = 0;

            function invoke(type, payload) {
                return new Promise(function (resolve, reject) {
                    const id = 'wv2_' + (++_seq);
                    pending[id] = { resolve, reject };
                    window.chrome.webview.postMessage(
                        JSON.stringify({ id, type, payload: payload ?? null })
                    );
                });
            }

            // C# calls this to resolve a pending JS promise
            window.__wv2HandleResponse = function (msg) {
                const p = pending[msg.id];
                if (!p) return;
                delete pending[msg.id];
                if (msg.result && typeof msg.result === 'object' && msg.result.error)
                    p.reject(new Error(msg.result.error));
                else
                    p.resolve(msg.result);
            };

            // C# calls this to fire a push event (native menu → JS)
            window.__wv2HandleEvent = function (msg) {
                window.dispatchEvent(
                    new CustomEvent('__wv2:' + msg.event, { detail: msg.detail ?? null })
                );
            };

            function on(eventName, cb) {
                window.addEventListener('__wv2:' + eventName, cb);
            }

            // Expose the same surface as the Electron contextBridge preload
            window.electronAPI = {
                isElectron:       true,
                saveAs:           function (name)          { return invoke('dialog:save-as', name); },
                openFile:         function ()              { return invoke('dialog:open', null); },
                writeFile:        function (fp, data)      { return invoke('file:save', { filePath: fp, data }); },
                getProjectPath:   function ()              { return invoke('project:get-path', null); },
                setProjectPath:   function (fp)            { return invoke('project:set-path', fp); },

                onMenuNewProject:   function (cb) { on('menu:new-project', cb); },
                onMenuOpenProject:  function (cb) { on('menu:open-project', cb); },
                onMenuSaveProject:  function (cb) { on('menu:save-project', cb); },
                onMenuExportIfc:    function (cb) { on('menu:export-ifc', cb); },
                onProjectOpened:    function (cb) {
                    on('project:opened', function (e) { cb(null, e.detail); });
                },
                onRequestSaveAs:    function (cb) { on('project:request-save-as', cb); },
                removeAllListeners: function ()   { /* DOM events are removed individually */ },
            };

            console.log('[BubbleGraph] WebView2 bridge ready');
        })();
        """;
}

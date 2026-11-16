// Opens a review URL in a VS Code tab through the Plannotator WebView extension.
// Outside a VS Code terminal (no PLANNOTATOR_VSCODE_PORT), or if the extension does not answer, it opens the
// default browser instead. Used as PLANNOTATOR_BROWSER, and by Claude for any other review page.
// Built by install.ps1 as a Windows (GUI) program, so it never opens a console window: the .cmd opener it
// replaces flashed one for every review, because `start` gives a batch file its own console.
using System;
using System.Diagnostics;
using System.Net;

static class OpenInVsCode
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length == 0 || args[0].Length == 0) return 0;
        string url = args[0];

        string port = Environment.GetEnvironmentVariable("PLANNOTATOR_VSCODE_PORT");
        if (!string.IsNullOrEmpty(port))
        {
            try
            {
                var request = (HttpWebRequest)WebRequest.Create(
                    "http://127.0.0.1:" + port + "/open?url=" + Uri.EscapeDataString(url));
                request.Timeout = 5000;
                request.Proxy = null;
                using (request.GetResponse()) { }   // throws on 4xx/5xx or no answer
                return 0;
            }
            catch (Exception) { }   // fall through to the browser
        }

        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            return 0;
        }
        catch (Exception) { return 1; }
    }
}

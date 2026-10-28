// SingleInstanceGuard.cs — keeps a single Zode shell alive.
//
// The second launch (for example a `zode://` activation while the app is
// already running) forwards its command line to the first instance through a
// named pipe instead of starting a second copy.

using System.IO.Pipes;
using System.Text;
using Zode.Shell.Diagnostics;

namespace Zode.Shell;

internal sealed class SingleInstanceGuard : IDisposable
{
    private const string MutexName = @"Global\Zode.NativeShell.4c1f9a2e";
    private const string PipeName = "zode-native-shell-4c1f9a2e";

    private Mutex? _mutex;
    private CancellationTokenSource? _cts;
    private Task? _listener;
    private bool _disposed;

    /// <summary>Raised when another instance forwarded its command line.</summary>
    public event Action<IReadOnlyList<string>>? CommandLineReceived;

    public bool TryAcquire()
    {
        try
        {
            _mutex = new Mutex(initiallyOwned: true, MutexName, out bool createdNew);
            if (!createdNew)
            {
                return false;
            }

            _cts = new CancellationTokenSource();
            _listener = Task.Run(() => ListenAsync(_cts.Token));
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn("single-instance", $"could not acquire the single-instance mutex: {ex.Message}");
            return true;
        }
    }

    /// <summary>Sends the command line to the running instance.</summary>
    public void ForwardCommandLine(IReadOnlyList<string> args)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out);
            client.Connect(2000);

            byte[] payload = Encoding.UTF8.GetBytes(string.Join("\n", args));
            byte[] length = BitConverter.GetBytes(payload.Length);
            client.Write(length, 0, length.Length);
            client.Write(payload, 0, payload.Length);
            client.Flush();
        }
        catch (Exception ex)
        {
            Log.Warn("single-instance", $"could not forward the command line: {ex.Message}");
        }
    }

    private async Task ListenAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    PipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(token).ConfigureAwait(false);

                byte[] lengthBytes = new byte[sizeof(int)];
                int read = await server.ReadAsync(lengthBytes, token).ConfigureAwait(false);
                if (read != lengthBytes.Length)
                {
                    continue;
                }

                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > 1_000_000)
                {
                    continue;
                }

                byte[] payload = new byte[length];
                int offset = 0;
                while (offset < length)
                {
                    int chunk = await server.ReadAsync(payload.AsMemory(offset, length - offset), token)
                        .ConfigureAwait(false);
                    if (chunk <= 0)
                    {
                        break;
                    }

                    offset += chunk;
                }

                string text = Encoding.UTF8.GetString(payload, 0, offset);
                IReadOnlyList<string> args = text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
                CommandLineReceived?.Invoke(args);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                Log.Warn("single-instance", $"pipe listener error: {ex.Message}");
            }
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        try
        {
            _cts?.Cancel();
        }
        catch (Exception)
        {
            // ignored
        }

        _cts?.Dispose();
        _mutex?.Dispose();
        _ = _listener;
    }
}

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>

#include <string>
#include <vector>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")

namespace {

std::wstring getExeDir() {
    std::vector<wchar_t> buf(MAX_PATH);
    DWORD len = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    while (len == buf.size()) {
        buf.resize(buf.size() * 2);
        len = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    }
    std::wstring path(buf.data(), len);
    size_t pos = path.find_last_of(L"\\/");
    return (pos == std::wstring::npos) ? L"." : path.substr(0, pos);
}

bool fileExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return (attr != INVALID_FILE_ATTRIBUTES) && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring expandEnv(const wchar_t* expr) {
    DWORD needed = ExpandEnvironmentStringsW(expr, nullptr, 0);
    if (needed == 0) return L"";
    std::wstring out(needed, L'\0');
    ExpandEnvironmentStringsW(expr, &out[0], needed);
    if (!out.empty() && out.back() == L'\0') out.pop_back();
    return out;
}

std::wstring findInPath(const wchar_t* exeName) {
    wchar_t buf[MAX_PATH] = {};
    DWORD len = SearchPathW(nullptr, exeName, nullptr, MAX_PATH, buf, nullptr);
    if (len > 0 && len < MAX_PATH) {
        return std::wstring(buf, len);
    }
    return L"";
}

std::wstring findNodeBinary(const std::wstring& appDir) {
    std::wstring bundled = appDir + L"\\runtime\\node.exe";
    if (fileExists(bundled)) return bundled;
    return findInPath(L"node.exe");
}

std::wstring findBrowserBinary() {
    const wchar_t* candidates[] = {
        L"%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
        L"%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
        L"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
        L"%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
        L"%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe",
    };
    for (const wchar_t* tpl : candidates) {
        std::wstring p = expandEnv(tpl);
        if (!p.empty() && fileExists(p)) return p;
    }
    std::wstring edge = findInPath(L"msedge.exe");
    if (!edge.empty()) return edge;
    return findInPath(L"chrome.exe");
}

bool isPortOpen(unsigned short port) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return false;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    bool open = (connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    closesocket(s);
    return open;
}

std::wstring quoteArg(const std::wstring& s) {
    return L"\"" + s + L"\"";
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);

    const unsigned short port = 8780;
    const std::wstring url = L"http://127.0.0.1:8780";
    const std::wstring appDir = getExeDir();
    SetCurrentDirectoryW(appDir.c_str());

    const std::wstring serverScript = appDir + L"\\server.mjs";
    if (!fileExists(serverScript)) {
        MessageBoxW(
            nullptr,
            L"server.mjs tidak ditemukan di folder aplikasi.\nPastikan seluruh isi folder ZIP sudah diekstrak sebelum menjalankan DM Audio.exe.",
            L"DM Audio — Error",
            MB_OK | MB_ICONERROR
        );
        WSACleanup();
        return 1;
    }

    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
        jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
    }

    PROCESS_INFORMATION serverPi{};
    bool startedServer = false;

    if (!isPortOpen(port)) {
        std::wstring nodeBin = findNodeBinary(appDir);
        if (nodeBin.empty()) {
            MessageBoxW(
                nullptr,
                L"Node.js (runtime\\node.exe) tidak ditemukan.\nDownload paket DM Audio Windows terbaru atau install Node.js LTS dari https://nodejs.org.",
                L"DM Audio — Error",
                MB_OK | MB_ICONERROR
            );
            if (job) CloseHandle(job);
            WSACleanup();
            return 1;
        }

        std::wstring logPath = appDir + L"\\dm-audio.log";
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = TRUE;
        HANDLE logFile = CreateFileW(
            logPath.c_str(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &sa,
            CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            nullptr
        );

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        if (logFile != INVALID_HANDLE_VALUE) {
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = logFile;
            si.hStdError = logFile;
        }

        std::wstring cmd = quoteArg(nodeBin) + L" " + quoteArg(serverScript);
        std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
        cmdBuf.push_back(L'\0');

        BOOL ok = CreateProcessW(
            nodeBin.c_str(),
            cmdBuf.data(),
            nullptr,
            nullptr,
            logFile != INVALID_HANDLE_VALUE ? TRUE : FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            appDir.c_str(),
            &si,
            &serverPi
        );
        if (logFile != INVALID_HANDLE_VALUE) CloseHandle(logFile);

        if (!ok) {
            MessageBoxW(
                nullptr,
                L"Gagal menjalankan DM Audio server (node.exe).",
                L"DM Audio — Error",
                MB_OK | MB_ICONERROR
            );
            if (job) CloseHandle(job);
            WSACleanup();
            return 1;
        }

        if (job) AssignProcessToJobObject(job, serverPi.hProcess);
        startedServer = true;

        // Wait up to 10 seconds for HTTP/WS server to start listening
        bool ready = false;
        for (int i = 0; i < 100; ++i) {
            if (isPortOpen(port)) {
                ready = true;
                break;
            }
            if (WaitForSingleObject(serverPi.hProcess, 100) == WAIT_OBJECT_0) {
                break;
            }
        }

        if (!ready) {
            MessageBoxW(
                nullptr,
                L"DM Audio server gagal startup pada port 8780.\nPeriksa file dm-audio.log di folder aplikasi.",
                L"DM Audio — Error",
                MB_OK | MB_ICONERROR
            );
            TerminateProcess(serverPi.hProcess, 1);
            CloseHandle(serverPi.hThread);
            CloseHandle(serverPi.hProcess);
            if (job) CloseHandle(job);
            WSACleanup();
            return 1;
        }
    }

    std::wstring browserBin = findBrowserBinary();
    bool launchedAppWindow = false;

    if (!browserBin.empty()) {
        std::wstring profileRoot = expandEnv(L"%LocalAppData%\\DM-Audio");
        CreateDirectoryW(profileRoot.c_str(), nullptr);
        std::wstring profileDir = profileRoot + L"\\WebProfile";
        CreateDirectoryW(profileDir.c_str(), nullptr);

        std::wstring cmd =
            quoteArg(browserBin) +
            L" --app=" + url +
            L" --user-data-dir=" + quoteArg(profileDir) +
            L" --no-first-run --no-default-browser-check --window-size=1320,820";
        std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
        cmdBuf.push_back(L'\0');

        STARTUPINFOW bsi{};
        bsi.cb = sizeof(bsi);
        PROCESS_INFORMATION bpi{};

        if (CreateProcessW(
                browserBin.c_str(),
                cmdBuf.data(),
                nullptr,
                nullptr,
                FALSE,
                0,
                nullptr,
                appDir.c_str(),
                &bsi,
                &bpi)) {
            launchedAppWindow = true;
            if (startedServer) {
                // Keep server alive until the DM Audio app window is closed
                HANDLE waitHandles[2] = { bpi.hProcess, serverPi.hProcess };
                WaitForMultipleObjects(2, waitHandles, FALSE, INFINITE);
            }
            CloseHandle(bpi.hThread);
            CloseHandle(bpi.hProcess);
        }
    }

    if (!launchedAppWindow) {
        ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
        if (startedServer) {
            MessageBoxW(
                nullptr,
                L"DM Audio sedang berjalan di http://127.0.0.1:8780.\nKlik OK untuk menghentikan Audio Engine & Server.",
                L"DM Audio — Digital Mixer",
                MB_OK | MB_ICONINFORMATION
            );
        }
    }

    if (startedServer) {
        if (job) {
            TerminateJobObject(job, 0);
        } else {
            TerminateProcess(serverPi.hProcess, 0);
        }
        CloseHandle(serverPi.hThread);
        CloseHandle(serverPi.hProcess);
    }

    if (job) CloseHandle(job);
    WSACleanup();
    return 0;
}

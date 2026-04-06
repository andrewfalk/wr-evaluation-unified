using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace EmrHelper
{
    static class Json
    {
        public static string Escape(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            return sb.ToString();
        }
    }

    class FailedField
    {
        public string Field;
        public string Reason;

        public FailedField(string field, string reason)
        {
            Field = field;
            Reason = reason;
        }
    }

    class CandidateWindow
    {
        public string Handle = "";
        public string Title = "";
        public bool MatchedTitle;
        public bool AppvSickFound;
        public bool JobCusFound;
        public bool IdacDteFound;
        public bool HcreTypeFound;
        public bool CpnyNmFound;
        public int Score;
        public bool Selected;
        public bool SendMessageOk;
        public string LResultHex = "";
        public bool ObjectFromLresultOk;
        public string ObjectError = "";
        public string DocumentType = "";
        public bool TitleReadOk;

        public string ToJson()
        {
            return string.Format(
                "{{\"handle\":\"{0}\",\"title\":\"{1}\",\"matchedTitle\":{2},\"appvSickFound\":{3},\"jobCusFound\":{4},\"idacDteFound\":{5},\"hcreTypeFound\":{6},\"cpnyNmFound\":{7},\"score\":{8},\"selected\":{9},\"sendMessageOk\":{10},\"lResultHex\":\"{11}\",\"objectFromLresultOk\":{12},\"objectError\":\"{13}\",\"documentType\":\"{14}\",\"titleReadOk\":{15}}}",
                Json.Escape(Handle),
                Json.Escape(Title),
                MatchedTitle ? "true" : "false",
                AppvSickFound ? "true" : "false",
                JobCusFound ? "true" : "false",
                IdacDteFound ? "true" : "false",
                HcreTypeFound ? "true" : "false",
                CpnyNmFound ? "true" : "false",
                Score,
                Selected ? "true" : "false",
                SendMessageOk ? "true" : "false",
                Json.Escape(LResultHex),
                ObjectFromLresultOk ? "true" : "false",
                Json.Escape(ObjectError),
                Json.Escape(DocumentType),
                TitleReadOk ? "true" : "false"
            );
        }
    }

    class Result
    {
        public bool Success;
        public string Message = "";
        public string WindowTitle = "";
        public bool TargetFound;
        public int ScannedCount;
        public List<string> FilledFields = new List<string>();
        public List<FailedField> FailedFields = new List<FailedField>();
        public List<string> TruncatedFields = new List<string>();
        public List<CandidateWindow> CandidateWindows = new List<CandidateWindow>();
        public string DebugSummary = "";

        public string ToJson()
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.AppendFormat("\"success\":{0}", Success ? "true" : "false");
            sb.AppendFormat(",\"message\":\"{0}\"", Json.Escape(Message));
            sb.AppendFormat(",\"windowTitle\":\"{0}\"", Json.Escape(WindowTitle));
            sb.AppendFormat(",\"targetFound\":{0}", TargetFound ? "true" : "false");
            sb.AppendFormat(",\"scannedCount\":{0}", ScannedCount);
            sb.AppendFormat(",\"debugSummary\":\"{0}\"", Json.Escape(DebugSummary));

            sb.Append(",\"filledFields\":[");
            for (int i = 0; i < FilledFields.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat("\"{0}\"", Json.Escape(FilledFields[i]));
            }
            sb.Append("]");

            sb.Append(",\"failedFields\":[");
            for (int i = 0; i < FailedFields.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat(
                    "{{\"field\":\"{0}\",\"reason\":\"{1}\"}}",
                    Json.Escape(FailedFields[i].Field),
                    Json.Escape(FailedFields[i].Reason)
                );
            }
            sb.Append("]");

            sb.Append(",\"truncatedFields\":[");
            for (int i = 0; i < TruncatedFields.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat("\"{0}\"", Json.Escape(TruncatedFields[i]));
            }
            sb.Append("]");

            sb.Append(",\"candidateWindows\":[");
            for (int i = 0; i < CandidateWindows.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(CandidateWindows[i].ToJson());
            }
            sb.Append("]");

            sb.Append("}");
            return sb.ToString();
        }
    }

    class FieldData
    {
        public Dictionary<string, string> Fields = new Dictionary<string, string>();
        public List<string> TruncatedFields = new List<string>();

        public string Get(string key)
        {
            string value;
            return Fields.TryGetValue(key, out value) ? value : "";
        }

        public static FieldData Parse(string json)
        {
            var fd = new FieldData();
            int i = 0;
            while (i < json.Length)
            {
                int keyStart = json.IndexOf('"', i);
                if (keyStart < 0) break;
                int keyEnd = json.IndexOf('"', keyStart + 1);
                if (keyEnd < 0) break;
                string key = json.Substring(keyStart + 1, keyEnd - keyStart - 1);

                int colon = json.IndexOf(':', keyEnd + 1);
                if (colon < 0) break;

                int afterColon = colon + 1;
                while (afterColon < json.Length && json[afterColon] == ' ') afterColon++;
                if (afterColon >= json.Length) break;

                if (key == "_truncatedFields")
                {
                    int arrStart = json.IndexOf('[', afterColon);
                    int arrEnd = json.IndexOf(']', arrStart + 1);
                    if (arrStart >= 0 && arrEnd > arrStart)
                    {
                        string inner = json.Substring(arrStart + 1, arrEnd - arrStart - 1);
                        int si = 0;
                        while (si < inner.Length)
                        {
                            int qs = inner.IndexOf('"', si);
                            if (qs < 0) break;
                            int qe = inner.IndexOf('"', qs + 1);
                            if (qe < 0) break;
                            fd.TruncatedFields.Add(inner.Substring(qs + 1, qe - qs - 1));
                            si = qe + 1;
                        }
                        i = arrEnd + 1;
                        continue;
                    }
                }

                if (json[afterColon] == '"')
                {
                    int valStart = afterColon + 1;
                    int valEnd = valStart;
                    while (valEnd < json.Length)
                    {
                        if (json[valEnd] == '\\')
                        {
                            valEnd += 2;
                            continue;
                        }
                        if (json[valEnd] == '"') break;
                        valEnd++;
                    }

                    string val = json.Substring(valStart, valEnd - valStart)
                        .Replace("\\n", "\n")
                        .Replace("\\r", "\r")
                        .Replace("\\t", "\t")
                        .Replace("\\\"", "\"")
                        .Replace("\\\\", "\\");

                    fd.Fields[key] = val;
                    i = valEnd + 1;
                }
                else
                {
                    i = afterColon + 1;
                }
            }

            return fd;
        }
    }

    static class Native
    {
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint RegisterWindowMessage(string lpString);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SendMessageTimeout(
            IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam,
            uint fuFlags, uint uTimeout, out IntPtr lpdwResult);

        [DllImport("oleacc.dll", PreserveSig = false)]
        [return: MarshalAs(UnmanagedType.Interface)]
        public static extern object ObjectFromLresult(
            IntPtr lResult,
            [MarshalAs(UnmanagedType.LPStruct)] Guid refiid,
            IntPtr wParam);

        public const uint SMTO_ABORTIFHUNG = 0x0002;
    }

    // ── Reflection-based IDispatch helpers (no dynamic, no Microsoft.CSharp) ──
    static class COM
    {
        public static object GetProp(object comObj, string name)
        {
            return comObj.GetType().InvokeMember(
                name, BindingFlags.GetProperty, null, comObj, null);
        }

        public static void SetProp(object comObj, string name, object value)
        {
            comObj.GetType().InvokeMember(
                name, BindingFlags.SetProperty, null, comObj, new[] { value });
        }

        public static object Invoke(object comObj, string name, params object[] args)
        {
            return comObj.GetType().InvokeMember(
                name, BindingFlags.InvokeMethod, null, comObj, args);
        }

        public static string GetStringProp(object comObj, string name)
        {
            try
            {
                object val = GetProp(comObj, name);
                return val != null ? val.ToString() : "";
            }
            catch
            {
                return "";
            }
        }

        public static int GetIntProp(object comObj, string name)
        {
            try
            {
                object val = GetProp(comObj, name);
                return Convert.ToInt32(val);
            }
            catch
            {
                return 0;
            }
        }
    }

    class Program
    {
        static readonly Guid IID_IHTMLDocument2 = new Guid("332C4425-26CB-11D0-B483-00C04FD90119");
        static Result _result;
        static bool _diagnose;

        static void Diag(string message)
        {
            if (_diagnose) Console.Error.WriteLine(message);
        }

        static List<IntPtr> FindIEServerHandles()
        {
            var handles = new List<IntPtr>();
            Native.EnumWindows((hWnd, _) =>
            {
                EnumChildrenRecursive(hWnd, handles);
                return true;
            }, IntPtr.Zero);
            return handles;
        }

        static void EnumChildrenRecursive(IntPtr parent, List<IntPtr> handles)
        {
            Native.EnumChildWindows(parent, (hWnd, _) =>
            {
                var sb = new StringBuilder(256);
                Native.GetClassName(hWnd, sb, 256);
                if (sb.ToString() == "Internet Explorer_Server")
                    handles.Add(hWnd);

                EnumChildrenRecursive(hWnd, handles);
                return true;
            }, IntPtr.Zero);
        }

        static string ToHex(IntPtr value)
        {
            return "0x" + value.ToInt64().ToString("X");
        }

        static object TryObjectFromLresult(IntPtr lResult, Guid iid, string iidLabel, CandidateWindow cw)
        {
            try
            {
                var obj = Native.ObjectFromLresult(lResult, iid, IntPtr.Zero);
                if (obj != null)
                {
                    cw.ObjectFromLresultOk = true;
                    cw.ObjectError = "";
                    cw.DocumentType = obj.GetType().FullName + " via " + iidLabel;
                    Diag(string.Format("[HWND {0}] ObjectFromLresult({1}): OK (type={2})", cw.Handle, iidLabel, cw.DocumentType));
                    return obj;
                }
                Diag(string.Format("[HWND {0}] ObjectFromLresult({1}): returned null", cw.Handle, iidLabel));
                return null;
            }
            catch (Exception ex)
            {
                if (!string.IsNullOrEmpty(cw.ObjectError)) cw.ObjectError += " | ";
                cw.ObjectError += iidLabel + ": " + ex.Message;
                Diag(string.Format("[HWND {0}] ObjectFromLresult({1}): EXCEPTION - {2}", cw.Handle, iidLabel, ex.Message));
                return null;
            }
        }

        static object GetDocument(IntPtr ieServerHwnd, CandidateWindow cw)
        {
            uint msg = Native.RegisterWindowMessage("WM_HTML_GETOBJECT");
            IntPtr lResult;
            IntPtr smResult = Native.SendMessageTimeout(
                ieServerHwnd, msg, IntPtr.Zero, IntPtr.Zero,
                Native.SMTO_ABORTIFHUNG, 2000, out lResult);

            cw.SendMessageOk = smResult != IntPtr.Zero;
            cw.LResultHex = ToHex(lResult);
            Diag(string.Format("[HWND {0}] SendMessageTimeout: smResult={1}, lResult={2}",
                cw.Handle, ToHex(smResult), cw.LResultHex));

            if (smResult == IntPtr.Zero)
            {
                cw.ObjectError = "SendMessageTimeout failed";
                return null;
            }
            if (lResult == IntPtr.Zero)
            {
                cw.ObjectError = "WM_HTML_GETOBJECT returned lResult=0";
                return null;
            }

            // lResult is single-use: only one ObjectFromLresult call per SendMessageTimeout
            var doc = TryObjectFromLresult(lResult, IID_IHTMLDocument2, "IHTMLDocument2", cw);
            if (doc != null) return doc;

            if (string.IsNullOrEmpty(cw.ObjectError))
                cw.ObjectError = "ObjectFromLresult failed";
            return null;
        }

        // ── DOM access via reflection (no dynamic keyword) ──

        static string GetDocumentTitle(object doc, CandidateWindow cw)
        {
            if (doc == null) return "";
            try
            {
                string title = COM.GetStringProp(doc, "title");
                cw.TitleReadOk = true;
                Diag(string.Format("[HWND {0}] title: \"{1}\"", cw.Handle, title));
                return title;
            }
            catch (Exception ex)
            {
                Diag(string.Format("[HWND {0}] title read FAILED: {1}", cw.Handle, ex.Message));
                return "";
            }
        }

        static bool TitleMatches(string title)
        {
            return
                title.IndexOf("DRFMNG", StringComparison.OrdinalIgnoreCase) >= 0 ||
                title.IndexOf("\uC5C5\uBB34\uAD00\uB828\uC131", StringComparison.Ordinal) >= 0 ||
                title.IndexOf("\uD2B9\uBCC4\uC9C4\uCC30", StringComparison.Ordinal) >= 0;
        }

        static int ScoreCandidate(CandidateWindow cw)
        {
            int score = 0;
            if (cw.AppvSickFound) score += 40;
            if (cw.JobCusFound) score += 40;
            if (cw.AppvSickFound && cw.JobCusFound) score += 40;
            if (cw.IdacDteFound) score += 15;
            if (cw.HcreTypeFound) score += 10;
            if (cw.CpnyNmFound) score += 10;
            if (cw.MatchedTitle) score += 5;
            return score;
        }

        static string BuildDebugSummary(int scannedCount, List<CandidateWindow> candidates)
        {
            int titleMatched = 0;
            int keyFieldCandidates = 0;
            int docObtained = 0;
            CandidateWindow best = null;

            foreach (var c in candidates)
            {
                if (c.ObjectFromLresultOk) docObtained++;
                if (c.MatchedTitle) titleMatched++;
                if (c.AppvSickFound && c.JobCusFound) keyFieldCandidates++;
                if (best == null || c.Score > best.Score) best = c;
            }

            int bits = IntPtr.Size == 8 ? 64 : 32;
            if (best == null)
            {
                return string.Format(
                    "Scanned {0} IE_Server(s), doc-obtained {1}, title-matched {2}, key-field candidates {3}, best score 0, helper={4}-bit.",
                    scannedCount, docObtained, titleMatched, keyFieldCandidates, bits);
            }

            return string.Format(
                "Scanned {0} IE_Server(s), doc-obtained {1}, title-matched {2}, key-field candidates {3}, best score {4} at {5} ({6}), helper={7}-bit.",
                scannedCount, docObtained, titleMatched, keyFieldCandidates,
                best.Score, best.Handle,
                string.IsNullOrEmpty(best.Title) ? "no title" : best.Title, bits);
        }

        /// <summary>
        /// Find element by ID or name using reflection-based COM access.
        /// Tries: doc.all.item(id) → doc.getElementById(id) → doc.getElementsByName(id)[0]
        /// </summary>
        static object FindElement(object doc, string idOrName)
        {
            if (doc == null || string.IsNullOrEmpty(idOrName)) return null;

            // Try doc.all.item(idOrName)
            try
            {
                object all = COM.GetProp(doc, "all");
                if (all != null)
                {
                    object found = COM.Invoke(all, "item", idOrName);
                    if (found != null) return found;
                }
            }
            catch { }

            // Try doc.getElementById(idOrName)
            try
            {
                object found = COM.Invoke(doc, "getElementById", idOrName);
                if (found != null) return found;
            }
            catch { }

            // Try doc.getElementsByName(idOrName)[0]
            try
            {
                object collection = COM.Invoke(doc, "getElementsByName", idOrName);
                if (collection != null)
                {
                    int len = COM.GetIntProp(collection, "length");
                    if (len > 0)
                    {
                        object first = COM.Invoke(collection, "item", 0);
                        if (first != null) return first;
                    }
                }
            }
            catch { }

            return null;
        }

        static object GetNamedElements(object doc, string name)
        {
            if (doc == null || string.IsNullOrEmpty(name)) return null;
            try
            {
                return COM.Invoke(doc, "getElementsByName", name);
            }
            catch
            {
                return null;
            }
        }

        static bool HasNamedElements(object doc, string name)
        {
            try
            {
                object collection = GetNamedElements(doc, name);
                if (collection == null) return false;
                return COM.GetIntProp(collection, "length") > 0;
            }
            catch
            {
                return false;
            }
        }

        static object FindEmrDocument(List<IntPtr> handles, out string title, out List<CandidateWindow> candidates)
        {
            title = "";
            candidates = new List<CandidateWindow>();
            object bestDoc = null;
            CandidateWindow bestCandidate = null;
            string bestTitle = "";

            foreach (var hwnd in handles)
            {
                var cw = new CandidateWindow();
                cw.Handle = ToHex(hwnd);

                var doc = GetDocument(hwnd, cw);
                if (doc == null)
                {
                    // Still add to candidates so diagnostics are visible
                    candidates.Add(cw);
                    continue;
                }

                string docTitle = GetDocumentTitle(doc, cw);
                cw.Title = docTitle;
                cw.MatchedTitle = TitleMatches(docTitle);
                cw.AppvSickFound = FindElement(doc, "txtAppv_Sick_Cont") != null;
                cw.JobCusFound = FindElement(doc, "txtJobCusCont") != null;
                cw.IdacDteFound = FindElement(doc, "txtIdacDte") != null;
                cw.HcreTypeFound = HasNamedElements(doc, "rdoHcreTypeCd");
                cw.CpnyNmFound = FindElement(doc, "txtCpnyNm") != null;
                cw.Score = ScoreCandidate(cw);

                Diag(string.Format(
                    "[HWND {0}] probes: appvSick={1}, jobCus={2}, idacDte={3}, hcreType={4}, cpnyNm={5}, score={6}",
                    cw.Handle, cw.AppvSickFound, cw.JobCusFound,
                    cw.IdacDteFound, cw.HcreTypeFound, cw.CpnyNmFound, cw.Score));

                candidates.Add(cw);

                if (cw.AppvSickFound && cw.JobCusFound)
                {
                    if (bestCandidate == null || cw.Score > bestCandidate.Score)
                    {
                        bestCandidate = cw;
                        bestDoc = doc;
                        bestTitle = docTitle;
                    }
                }
            }

            if (bestCandidate != null)
            {
                bestCandidate.Selected = true;
                title = bestTitle;
                return bestDoc;
            }
            return null;
        }

        static void SetField(object doc, string fieldId, string value)
        {
            if (string.IsNullOrEmpty(value)) return;

            try
            {
                object elem = FindElement(doc, fieldId);
                if (elem == null)
                {
                    _result.FailedFields.Add(new FailedField(fieldId, "element not found"));
                    return;
                }

                COM.SetProp(elem, "value", value);
                try { COM.Invoke(elem, "FireEvent", "onchange"); } catch { }
                try { COM.Invoke(elem, "FireEvent", "onblur"); } catch { }
                _result.FilledFields.Add(fieldId);
            }
            catch (Exception ex)
            {
                _result.FailedFields.Add(new FailedField(fieldId, ex.Message));
            }
        }

        static void SetRadio(object doc, string groupName, string value)
        {
            if (string.IsNullOrEmpty(value)) return;

            try
            {
                object radios = GetNamedElements(doc, groupName);
                if (radios == null)
                {
                    _result.FailedFields.Add(new FailedField("radio:" + groupName, "group not found"));
                    return;
                }

                int len = COM.GetIntProp(radios, "length");
                bool found = false;

                for (int i = 0; i < len; i++)
                {
                    object radio = COM.Invoke(radios, "item", i);
                    if (radio == null) continue;

                    string radioName = COM.GetStringProp(radio, "name");
                    string radioValue = COM.GetStringProp(radio, "value");

                    if (radioName != groupName) continue;
                    if (radioValue != value) continue;

                    COM.SetProp(radio, "checked", true);
                    try { COM.Invoke(radio, "FireEvent", "onclick"); } catch { }
                    try { COM.Invoke(radio, "FireEvent", "onchange"); } catch { }
                    found = true;
                    break;
                }

                if (found)
                    _result.FilledFields.Add("radio:" + groupName + "=" + value);
                else
                    _result.FailedFields.Add(new FailedField("radio:" + groupName, "value '" + value + "' not matched"));
            }
            catch (Exception ex)
            {
                _result.FailedFields.Add(new FailedField("radio:" + groupName, ex.Message));
            }
        }

        static void ClickButton(object doc, string buttonId)
        {
            try
            {
                object btn = FindElement(doc, buttonId);
                if (btn != null) COM.Invoke(btn, "click");
            }
            catch { }
        }

        static bool WaitForElement(object doc, string fieldId, int timeoutMs, int intervalMs)
        {
            int elapsed = 0;
            while (elapsed < timeoutMs)
            {
                Thread.Sleep(intervalMs);
                elapsed += intervalMs;
                if (FindElement(doc, fieldId) != null) return true;
            }
            return false;
        }

        [STAThread]
        static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            _result = new Result();

            if (args.Length == 0)
            {
                _result.Message = "Usage: EmrHelper.exe [--diagnose] --probe | [--diagnose] --json <path>";
                Console.WriteLine(_result.ToJson());
                return 1;
            }

            bool probeOnly = false;
            string jsonPath = null;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--probe") probeOnly = true;
                else if (args[i] == "--diagnose") _diagnose = true;
                else if (args[i] == "--json" && i + 1 < args.Length) jsonPath = args[++i];
            }

            var handles = FindIEServerHandles();
            _result.ScannedCount = handles.Count;
            Diag(string.Format("Found {0} IE_Server handle(s), helper={1}-bit",
                handles.Count, IntPtr.Size == 8 ? 64 : 32));

            if (handles.Count == 0)
            {
                _result.Message = "No Internet Explorer_Server found. Is EMR running?";
                Console.WriteLine(_result.ToJson());
                return 1;
            }

            string windowTitle;
            List<CandidateWindow> candidates;
            var doc = FindEmrDocument(handles, out windowTitle, out candidates);
            _result.CandidateWindows = candidates;
            _result.DebugSummary = BuildDebugSummary(handles.Count, candidates);

            if (doc == null)
            {
                _result.Message = "EMR form not found. " + _result.DebugSummary;
                Console.WriteLine(_result.ToJson());
                return 1;
            }

            _result.TargetFound = true;
            _result.WindowTitle = windowTitle;

            if (probeOnly)
            {
                _result.Success = true;
                _result.Message = "EMR form detected. " + _result.DebugSummary;
                Console.WriteLine(_result.ToJson());
                return 0;
            }

            if (string.IsNullOrEmpty(jsonPath) || !File.Exists(jsonPath))
            {
                _result.Message = "JSON file not found: " + (jsonPath ?? "(null)");
                Console.WriteLine(_result.ToJson());
                return 1;
            }

            string rawJson = File.ReadAllText(jsonPath, Encoding.UTF8);
            var data = FieldData.Parse(rawJson);
            _result.TruncatedFields = data.TruncatedFields;

            // Tab 1 fields
            SetField(doc, "txtAppv_Sick_Cont", data.Get("txtAppvSickCont"));
            SetField(doc, "txtJobCusCont", data.Get("txtJobCusCont"));
            SetField(doc, "txtPerCusCont", data.Get("txtPerCusCont"));
            SetField(doc, "txtIdacDte", data.Get("txtIdacDte"));
            SetField(doc, "txtCpnyNm", data.Get("txtCpnyNm"));

            SetRadio(doc, "rdoCls", data.Get("rdoCls"));
            SetRadio(doc, "rdoHcreTypeCd", data.Get("rdoHcreTypeCd"));

            // Switch to tab 2
            ClickButton(doc, "BtnTab02");
            bool tab2Ready = WaitForElement(doc, "txtSyth1Cont", 3000, 500);

            if (tab2Ready)
            {
                SetField(doc, "txtSyth1Cont", data.Get("txtSyth1Cont"));
                SetField(doc, "txtSyth2Cont", data.Get("txtSyth2Cont"));
                SetField(doc, "txtSyth3Cont", data.Get("txtSyth3Cont"));
                SetField(doc, "txtArrv1Cont", data.Get("txtArrv1Cont"));
                SetField(doc, "txtArrv2Cont", data.Get("txtArrv2Cont"));
                SetField(doc, "txtArrv3Cont", data.Get("txtArrv3Cont"));

                string evalType = data.Get("rdoEvalTypeCd");
                if (!string.IsNullOrEmpty(evalType)) SetRadio(doc, "rdoEvalTypeCd", evalType);

                string cureCost = data.Get("rdoCureCost");
                if (!string.IsNullOrEmpty(cureCost)) SetRadio(doc, "rdoCureCost", cureCost);
            }
            else
            {
                _result.FailedFields.Add(new FailedField("tab2", "tab2Ready=false"));
            }

            // Return to tab 1
            ClickButton(doc, "BtnTab01");

            _result.Success = _result.FilledFields.Count > 0;
            if (_result.FailedFields.Count == 0)
            {
                _result.Message = string.Format("EMR filled {0} field(s)", _result.FilledFields.Count);
            }
            else
            {
                _result.Message = string.Format(
                    "EMR partially filled (ok: {0}, fail: {1})",
                    _result.FilledFields.Count, _result.FailedFields.Count);
            }

            Console.WriteLine(_result.ToJson());
            return 0;
        }
    }
}

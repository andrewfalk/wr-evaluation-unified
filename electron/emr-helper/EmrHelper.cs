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

        // ── Generic page finder: reuses FindIEServerHandles + GetDocument ──

        static object FindDocumentByMatch(List<IntPtr> handles, string urlFragment, string titleFragment)
        {
            foreach (var hwnd in handles)
            {
                var cw = new CandidateWindow();
                cw.Handle = ToHex(hwnd);
                var doc = GetDocument(hwnd, cw);
                if (doc == null) continue;

                if (!string.IsNullOrEmpty(urlFragment))
                {
                    string url = COM.GetStringProp(doc, "URL");
                    if (url.IndexOf(urlFragment, StringComparison.OrdinalIgnoreCase) >= 0)
                        return doc;
                }
                if (!string.IsNullOrEmpty(titleFragment))
                {
                    string title = COM.GetStringProp(doc, "title");
                    if (title.IndexOf(titleFragment, StringComparison.OrdinalIgnoreCase) >= 0)
                        return doc;
                }
            }
            return null;
        }

        static string ReadField(object doc, string fieldId)
        {
            try
            {
                object elem = FindElement(doc, fieldId);
                if (elem == null) return "";
                string val = COM.GetStringProp(elem, "value");
                return val ?? "";
            }
            catch { return ""; }
        }

        /// <summary>
        /// Read a cell from a FarPoint Spread ActiveX control.
        /// GetText(col, row, outVal) uses ByRef for the 3rd param —
        /// ParameterModifier is REQUIRED or the COM binder sends by-value and outVal is always null.
        /// </summary>
        static string ReadSpreadCell(object spread, int col, int row)
        {
            try
            {
                object[] args = { col, row, null };
                ParameterModifier pm = new ParameterModifier(3);
                pm[2] = true; // 3rd parameter is ByRef
                spread.GetType().InvokeMember(
                    "GetText",
                    BindingFlags.InvokeMethod,
                    null, spread, args,
                    new ParameterModifier[] { pm },
                    null, null);
                return args[2] != null ? args[2].ToString() : "";
            }
            catch { return ""; }
        }

        // ── RecordExtractor: Module1 VBA → C# ──

        const int MAX_SCAN = 20; // 입력내역 그리드 스캔 상한 (비정상적으로 많은 행 방지)

        static string ExtractRecord(List<IntPtr> handles, string patientNo, string targetInjuryDate)
        {
            var doc = FindDocumentByMatch(handles, "CREATEDUTYANLYNEW", null);
            if (doc == null)
                return "{\"success\":false,\"error\":\"진료기록분석지 페이지를 찾을 수 없습니다.\"}";

            // Set patient number and trigger query
            object txtPtNo = FindElement(doc, "txtPtNo");
            if (txtPtNo == null)
                return "{\"success\":false,\"error\":\"txtPtNo 필드를 찾을 수 없습니다.\"}";

            object pw = null;
            COM.SetProp(txtPtNo, "value", patientNo);
            try
            {
                pw = COM.GetProp(doc, "parentWindow");
                COM.Invoke(pw, "execScript", "PtInfoSetting()", "vbscript");
            }
            catch (Exception ex)
            {
                return string.Format("{{\"success\":false,\"error\":\"execScript 실패: {0}\"}}", Json.Escape(ex.Message));
            }

            // PtInfoSetting()은 시작 시 txtSsnNo 등 기본정보를 동기적으로 비운 뒤,
            // 새 환자 조회 결과(비동기 서버 응답)로 다시 채운다. 따라서 배치 모드에서
            // 이전 환자의 잔상 그리드(MaxRows>0)를 새 환자로 오인하지 않도록, witness 필드
            // (txtSsnNo)가 다시 채워질 때(=조회 완료)까지 먼저 폴링한다. (최대 8s)
            WaitFieldNonEmpty(doc, "txtSsnNo", 8000);

            // 그 다음 입력내역 그리드(SSRHPLANLIST)가 채워질 때까지 폴링 (최대 6s)
            object spreadObj = WaitGridReady(doc, "SSRHPLANLIST", 6000);

            // ── 입력내역(SSRHPLANLIST) 행 선택: 재해일자 매칭 ──
            bool multipleEntries = false;
            bool injuryDateMismatch = false;
            int recordCount = (spreadObj != null) ? COM.GetIntProp(spreadObj, "MaxRows") : 0;
            multipleEntries = recordCount > 1;
            string normTarget = NormalizeDate(targetInjuryDate);

            if (recordCount > 0)
            {
                int scanCount = Math.Min(recordCount, MAX_SCAN); // 유효 행 1..scanCount (1-based)

                // 행 1 먼저 로드 (재해일자 미입력 시 기존과 동일하게 1번 항목 사용)
                string row1Date = SelectRowAndReadDate(doc, pw, 1, 4000);

                if (!string.IsNullOrEmpty(normTarget) && NormalizeDate(row1Date) != normTarget)
                {
                    // 행 1 불일치 → 2번부터 순회하며 일치 행 탐색
                    bool found = false;
                    for (int r = 2; r <= scanCount; r++)
                    {
                        string rowDate = SelectRowAndReadDate(doc, pw, r, 4000);
                        if (NormalizeDate(rowDate) == normTarget) { found = true; break; }
                    }
                    if (!found)
                    {
                        // 일치 건 없음 → 행 1 재로드 + 플래그 (renderer 경고)
                        SelectRowAndReadDate(doc, pw, 1, 4000);
                        injuryDateMismatch = true;
                    }
                }
            }

            // Read basic info
            string patientName = ReadField(doc, "txtptNm");
            string idacDate = ReadField(doc, "txtIdac_Dte");
            string sickCont = ReadField(doc, "txtSick_Cont");

            // Parse birth date / gender from SSN (한 번만 읽어 공용)
            string ssnRaw = ReadField(doc, "txtSsnNo");
            string birthDate = ParseBirthDate(ssnRaw);
            string gender = DeriveGender(ReadField(doc, "txtSex"), ssnRaw);

            // Read medical records
            string sptCont = ReadField(doc, "txtSpt_Cont").Trim();
            string mriDate = ReadField(doc, "txtMri_Dte_Txt").Trim().Replace("\r\n", "").Replace("\n", "");
            string mriMain = ReadField(doc, "txtMri_Mian_Cont").Trim();
            string opDate = ReadField(doc, "txtOp_Dte").Trim().Replace("\r\n", "").Replace("\n", "");
            string opMain = ReadField(doc, "txtOp_Main_Cont").Trim();
            string opTst = ReadField(doc, "txtOp_Tst_Cont").Trim();

            // Assemble medical record summary
            if (string.IsNullOrEmpty(sptCont)) sptCont = "없음";

            string mriCombined;
            if (string.IsNullOrEmpty(mriDate) && string.IsNullOrEmpty(mriMain))
            {
                mriCombined = "없음";
            }
            else
            {
                if (string.IsNullOrEmpty(mriDate)) mriDate = "없음";
                if (string.IsNullOrEmpty(mriMain)) mriMain = "없음";
                int lfPos = mriMain.IndexOf('\n');
                if (lfPos >= 0)
                    mriCombined = mriDate + " " + mriMain.Substring(0, lfPos).Trim() + "\n" + mriMain.Substring(lfPos + 1).Trim();
                else
                    mriCombined = mriDate + " " + mriMain;
            }

            string opCombined;
            if (string.IsNullOrEmpty(opDate) && string.IsNullOrEmpty(opMain) && string.IsNullOrEmpty(opTst))
            {
                opCombined = "없음";
            }
            else
            {
                if (string.IsNullOrEmpty(opDate)) opDate = "없음";
                if (string.IsNullOrEmpty(opMain)) opMain = "없음";
                if (string.IsNullOrEmpty(opTst)) opTst = "없음";
                opCombined = opDate + " " + opMain + "\n" + opTst;
            }

            string medicalRecord = "\n[ 의무 기록 ]\n" + sptCont +
                                   "\n[ 영상 검사 ]\n" + mriCombined +
                                   "\n[ 수술 이력 ]\n" + opCombined;

            // Analyze FarPoint Spread (sprYoyang): highBP, diabetes, visit history
            string highBP = "무", diabetes = "무", visitHistory = "";
            object sprYoyang = FindElement(doc, "sprYoyang");
            if (sprYoyang != null)
            {
                int maxRow = COM.GetIntProp(sprYoyang, "MaxRows");

                // Check first row for highBP/diabetes
                if (maxRow >= 1)
                {
                    string firstVal = ReadSpreadCell(sprYoyang, 2, 1);
                    if (firstVal.IndexOf("고혈압") >= 0) highBP = "유";
                    if (firstVal.IndexOf("당뇨") >= 0) diabetes = "유";
                }

                // Visit history calculation
                var visitParts = new List<string>();
                bool isTracking = false;
                string currentPrefix = "", currentDate = "";
                long currentSum = 0;
                string minDate = "9999-12-31";
                long totalSum = 0;

                for (int y = 1; y <= maxRow; y++)
                {
                    string valCol2 = ReadSpreadCell(sprYoyang, 2, y);
                    string valCol3 = ReadSpreadCell(sprYoyang, 3, y);
                    string valCol7 = ReadSpreadCell(sprYoyang, 7, y);

                    // Extract number from col7
                    long extractedNum = ExtractNumber(valCol7);
                    totalSum += extractedNum;

                    // Track min date
                    if (!string.IsNullOrEmpty(valCol3) && valCol3 != "1111-11-11" && string.Compare(valCol3, minDate) < 0)
                        minDate = valCol3;

                    // Match body part prefix
                    string matchedPrefix = MatchBodyPart(valCol2);

                    if (!string.IsNullOrEmpty(matchedPrefix))
                    {
                        if (isTracking)
                        {
                            visitParts.Add(FormatVisitEntry(currentPrefix, currentDate, currentSum));
                        }
                        currentPrefix = matchedPrefix;
                        currentSum = 0;
                        isTracking = true;

                        // Get next row's date
                        if (y < maxRow)
                        {
                            string nd = ReadSpreadCell(sprYoyang, 3, y + 1);
                            currentDate = (string.IsNullOrEmpty(nd) || nd == "1111-11-11") ? "" : nd;
                        }
                        else
                        {
                            currentDate = "";
                        }
                    }
                    else if (isTracking)
                    {
                        currentSum += extractedNum;
                    }
                }

                // Final tracking entry
                if (isTracking)
                {
                    visitParts.Add(FormatVisitEntry(currentPrefix, currentDate, currentSum));
                }

                if (visitParts.Count > 0)
                    visitHistory = string.Join("\n", visitParts.ToArray());
                else if (minDate != "9999-12-31")
                    visitHistory = minDate + " 부터 " + totalSum + " 회";
            }

            // Parse disease codes from sickCont
            var diseases = ParseDiseaseCodes(sickCont);

            // Build JSON output
            var sb = new StringBuilder();
            sb.Append("{\"success\":true");
            sb.AppendFormat(",\"patientNo\":\"{0}\"", Json.Escape(patientNo));
            sb.AppendFormat(",\"patientName\":\"{0}\"", Json.Escape(patientName));
            sb.AppendFormat(",\"birthDate\":\"{0}\"", Json.Escape(birthDate));
            sb.AppendFormat(",\"accidentDate\":\"{0}\"", Json.Escape(idacDate));
            sb.AppendFormat(",\"medicalRecord\":\"{0}\"", Json.Escape(medicalRecord));
            sb.AppendFormat(",\"highBloodPressure\":\"{0}\"", Json.Escape(highBP));
            sb.AppendFormat(",\"diabetes\":\"{0}\"", Json.Escape(diabetes));
            sb.AppendFormat(",\"visitHistory\":\"{0}\"", Json.Escape(visitHistory));
            sb.AppendFormat(",\"gender\":\"{0}\"", Json.Escape(gender));
            sb.AppendFormat(",\"multipleEntries\":{0}", multipleEntries ? "true" : "false");
            sb.AppendFormat(",\"injuryDateMismatch\":{0}", injuryDateMismatch ? "true" : "false");
            sb.Append(",\"diseases\":[");
            for (int i = 0; i < diseases.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat("{{\"code\":\"{0}\",\"name\":\"{1}\"}}", Json.Escape(diseases[i][0]), Json.Escape(diseases[i][1]));
            }
            sb.Append("]}");
            return sb.ToString();
        }

        /// <summary>
        /// 필드(witness)가 비어있지 않게 될 때까지 ~150ms 간격 폴링(최대 maxMs). 현재 값 반환.
        /// PtInfoSetting()이 동기적으로 비운 필드가 새 환자 조회 결과로 다시 채워졌는지 확인하는 용도.
        /// </summary>
        static string WaitFieldNonEmpty(object doc, string fieldId, int maxMs)
        {
            int waited = 0;
            string cur = "";
            while (waited < maxMs)
            {
                cur = ReadField(doc, fieldId);
                if (!string.IsNullOrEmpty(cur)) return cur;
                Thread.Sleep(150);
                waited += 150;
            }
            return cur;
        }

        /// <summary>
        /// SSRHPLANLIST 등 FarPoint Spread 그리드가 채워질 때까지(MaxRows>0) 폴링.
        /// 고정 Sleep 대신 사용. 최대 maxMs까지 대기 후 그리드 객체(채워지지 않았으면 그대로) 반환.
        /// </summary>
        static object WaitGridReady(object doc, string id, int maxMs)
        {
            int waited = 0;
            object grid = null;
            while (waited < maxMs)
            {
                grid = FindElement(doc, id);
                if (grid != null && COM.GetIntProp(grid, "MaxRows") > 0) return grid;
                Thread.Sleep(150);
                waited += 150;
            }
            return grid;
        }

        /// <summary>
        /// 입력내역 그리드의 row행(1-based)을 더블클릭해 상세를 로드하고 재해일자(txtIdac_Dte)를 반환.
        /// 핸들러 시그니처는 SSRHPLANLIST_DblClick(iCol, iRow) = (열, 행)이며 행은 1-based —
        /// 따라서 열 0 고정, 행에 row를 넘긴다(iCol 미사용). 원본 호출 SSRHPLANLIST_DblClick(0, 1)과 동일 순서.
        /// 고정 4초 Sleep 대신, 더블클릭 전 값에서 바뀔 때까지 ~150ms 간격 폴링(최대 maxMs).
        /// 변경이 감지되면 나머지 상세 필드 로드를 위해 짧게 더 대기. 변경이 없으면(이미 동일 건 로드)
        /// 현재 값을 반환 → 정상 케이스는 행당 1초 미만.
        /// </summary>
        static string SelectRowAndReadDate(object doc, object pw, int row, int maxMs)
        {
            string before = ReadField(doc, "txtIdac_Dte");
            try
            {
                COM.Invoke(pw, "execScript", "Call SSRHPLANLIST_DblClick(0, " + row + ")", "vbscript");
            }
            catch { }

            int waited = 0;
            while (waited < maxMs)
            {
                Thread.Sleep(150);
                waited += 150;
                if (ReadField(doc, "txtIdac_Dte") != before)
                {
                    Thread.Sleep(300); // 나머지 상세 필드(신청상병·의무기록 등) 로드 여유
                    break;
                }
            }
            return ReadField(doc, "txtIdac_Dte");
        }

        /// <summary>날짜 문자열에서 숫자만 추출 (2023-07-31 / 2023.07.31 → 20230731).</summary>
        static string NormalizeDate(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (char c in s) if (c >= '0' && c <= '9') sb.Append(c);
            return sb.ToString();
        }

        /// <summary>
        /// 성별을 앱 형식("male"/"female"/"")으로 산출.
        /// txtSex 값(남/여 등) 정확 매칭 우선, 비어 있으면 주민번호 7번째 숫자(1·3·5·7=남, 2·4·6·8=여)로 판정.
        /// </summary>
        static string DeriveGender(string sexRaw, string ssn)
        {
            string s = (sexRaw ?? "").Trim().ToLowerInvariant();
            if (s == "남" || s == "남자" || s == "남성" || s == "m" || s == "male") return "male";
            if (s == "여" || s == "여자" || s == "여성" || s == "f" || s == "female") return "female";

            string digits = NormalizeDate(ssn);
            if (digits.Length >= 7)
            {
                char g = digits[6];
                if (g == '1' || g == '3' || g == '5' || g == '7') return "male";
                if (g == '2' || g == '4' || g == '6' || g == '8') return "female";
            }
            return "";
        }

        static string ParseBirthDate(string ssn)
        {
            if (string.IsNullOrEmpty(ssn)) return "";
            ssn = ssn.Replace("-", "");
            if (ssn.Length < 6) return "";

            string yy = ssn.Substring(0, 2);
            string mm = ssn.Substring(2, 2);
            string dd = ssn.Substring(4, 2);
            string century = "19";
            if (ssn.Length >= 7)
            {
                char g = ssn[6];
                if (g == '3' || g == '4' || g == '7' || g == '8') century = "20";
            }
            else
            {
                int yyInt;
                if (int.TryParse(yy, out yyInt) && yyInt <= 30) century = "20";
            }
            return century + yy + "-" + mm + "-" + dd;
        }

        static long ExtractNumber(string s)
        {
            if (string.IsNullOrEmpty(s)) return 0;
            var numStr = new StringBuilder();
            foreach (char c in s)
            {
                if (c >= '0' && c <= '9') numStr.Append(c);
            }
            if (numStr.Length == 0) return 0;
            long val;
            return long.TryParse(numStr.ToString(), out val) ? val : 0;
        }

        static string MatchBodyPart(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            if (text.IndexOf("경추") >= 0) return "목 부위";
            // "목" standalone check (not part of compound word)
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == '목')
                {
                    bool leftOk = (i == 0 || !IsKoreanOrAlphaNum(text[i - 1]));
                    bool rightOk = (i == text.Length - 1 || !IsKoreanOrAlphaNum(text[i + 1]));
                    if (leftOk && rightOk) return "목 부위";
                }
            }
            if (text.IndexOf("어깨") >= 0 || text.IndexOf("견관절") >= 0) return "어깨 부위";
            if (text.IndexOf("팔꿈치") >= 0 || text.IndexOf("주관절") >= 0) return "팔꿈치 부위";
            if (text.IndexOf("손목") >= 0 || text.IndexOf("손가락") >= 0 || text.IndexOf("완관절") >= 0 || text.IndexOf("손") >= 0) return "손목 부위";
            if (text.IndexOf("무릎") >= 0 || text.IndexOf("슬관절") >= 0) return "무릎 부위";
            if (text.IndexOf("허리") >= 0 || text.IndexOf("요추") >= 0) return "허리 부위";
            if (text.IndexOf("발목") >= 0 || text.IndexOf("족관절") >= 0) return "발목 부위";
            if (text.IndexOf("고관절") >= 0) return "고관절 부위";
            return "";
        }

        static bool IsKoreanOrAlphaNum(char c)
        {
            if (c >= '가' && c <= '힣') return true;
            if (c >= 'a' && c <= 'z') return true;
            if (c >= 'A' && c <= 'Z') return true;
            if (c >= '0' && c <= '9') return true;
            return false;
        }

        static string FormatVisitEntry(string prefix, string date, long count)
        {
            if (count == 0 || string.IsNullOrEmpty(date))
                return prefix + " 수진 이력 없음";
            return prefix + " : " + date + " 이후 " + count + " 회";
        }

        static List<string[]> ParseDiseaseCodes(string sickCont)
        {
            var result = new List<string[]>();
            if (string.IsNullOrEmpty(sickCont)) return result;

            // Find all matches of pattern: uppercase letter + 3-5 digits
            var codes = new List<int[]>(); // [startIndex, length]
            for (int i = 0; i < sickCont.Length; i++)
            {
                char c = sickCont[i];
                if (c >= 'A' && c <= 'Z')
                {
                    int j = i + 1;
                    while (j < sickCont.Length && j - i <= 5 && sickCont[j] >= '0' && sickCont[j] <= '9') j++;
                    int digitCount = j - i - 1;
                    if (digitCount >= 3 && digitCount <= 5)
                    {
                        codes.Add(new int[] { i, j - i });
                        i = j - 1; // skip past matched code
                    }
                }
            }

            for (int m = 0; m < codes.Count; m++)
            {
                string code = sickCont.Substring(codes[m][0], codes[m][1]);
                int nameStart = codes[m][0] + codes[m][1];
                int nameEnd = (m + 1 < codes.Count) ? codes[m + 1][0] : sickCont.Length;
                string name = sickCont.Substring(nameStart, nameEnd - nameStart).Trim().Replace("\r", "").Replace("\n", "");
                result.Add(new string[] { code, name });
            }

            return result;
        }

        // ── ConsultationExtractor: Module3 VBA → C# ──

        static string ExtractConsultation(List<IntPtr> handles)
        {
            // Find 진료메인 page by title
            var doc = FindDocumentByMatch(handles, null, "\uC9C4\uB8CC\uBA54\uC778"); // "진료메인"
            if (doc == null)
                return "{\"success\":false,\"error\":\"진료메인 페이지를 찾을 수 없습니다.\"}";

            // Navigate frames: topFrame → leftIFrame → NoteViewer
            object targetDoc = null;
            try
            {
                object frames = COM.GetProp(doc, "frames");
                object topFrame = COM.Invoke(frames, "item", "topFrame");
                object topDoc = COM.GetProp(topFrame, "document");

                object topFrames = COM.GetProp(topDoc, "frames");
                object leftFrame = COM.Invoke(topFrames, "item", "leftIFrame");
                object leftDoc = COM.GetProp(leftFrame, "document");

                object leftFrames = COM.GetProp(leftDoc, "frames");
                object noteViewer = COM.Invoke(leftFrames, "item", "NoteViewer");
                targetDoc = COM.GetProp(noteViewer, "document");
            }
            catch { }

            // Fallback: try getElementById approach
            if (targetDoc == null)
            {
                try
                {
                    object topEl = COM.Invoke(doc, "getElementById", "topFrame");
                    object topCW = COM.GetProp(topEl, "contentWindow");
                    object topDoc = COM.GetProp(topCW, "document");

                    object leftEl = COM.Invoke(topDoc, "getElementById", "leftIFrame");
                    object leftCW = COM.GetProp(leftEl, "contentWindow");
                    object leftDoc = COM.GetProp(leftCW, "document");

                    object noteEl = COM.Invoke(leftDoc, "getElementById", "NoteViewer");
                    object noteCW = COM.GetProp(noteEl, "contentWindow");
                    targetDoc = COM.GetProp(noteCW, "document");
                }
                catch { }
            }

            if (targetDoc == null)
                return "{\"success\":false,\"error\":\"프레임 탐색 실패 (topFrame/leftIFrame/NoteViewer)\"}";

            // Extract consultation replies from width=590 tables
            var consultations = new List<string[]>(); // [department, content]
            try
            {
                object allTables = COM.Invoke(targetDoc, "getElementsByTagName", "table");
                int tableCount = COM.GetIntProp(allTables, "length");

                for (int t = 0; t < tableCount; t++)
                {
                    object tbl = COM.Invoke(allTables, "item", t);
                    if (tbl == null) continue;

                    string widthAttr = "";
                    try { object wa = COM.Invoke(tbl, "getAttribute", "width"); widthAttr = wa != null ? wa.ToString() : ""; } catch { }
                    if (widthAttr != "590") continue;

                    string tblText = COM.GetStringProp(tbl, "innerText").Replace(" ", "");
                    string dept = "";
                    if (tblText.IndexOf("\uB2E4\uD559\uC81C\uD68C\uC2E0:\uC815\uD615\uC678\uACFC") >= 0) dept = "정형외과";
                    else if (tblText.IndexOf("\uB2E4\uD559\uC81C\uD68C\uC2E0:\uC2E0\uACBD\uC678\uACFC") >= 0) dept = "신경외과";
                    else if (tblText.IndexOf("\uB2E4\uD559\uC81C\uD68C\uC2E0:\uC7AC\uD65C\uC758\uD559\uACFC") >= 0) dept = "재활의학과";
                    if (string.IsNullOrEmpty(dept)) continue;

                    if (tblText.IndexOf("\uD68C\uC2E0\uB0B4\uC6A9") < 0) continue; // "회신내용"

                    // Find the cell with "회신내용" and get the next cell
                    object cells = COM.GetProp(tbl, "cells");
                    int cellCount = COM.GetIntProp(cells, "length");
                    for (int ci = 0; ci < cellCount; ci++)
                    {
                        object cell = COM.Invoke(cells, "item", ci);
                        string cellText = COM.GetStringProp(cell, "innerText").Replace("\r", "").Replace("\n", "").Replace(" ", "");
                        if (cellText == "\uD68C\uC2E0\uB0B4\uC6A9" && ci + 1 < cellCount) // "회신내용"
                        {
                            object nextCell = COM.Invoke(cells, "item", ci + 1);
                            string content = COM.GetStringProp(nextCell, "innerText").Trim();
                            consultations.Add(new string[] { dept, content });
                            break;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                return string.Format("{{\"success\":false,\"error\":\"테이블 파싱 오류: {0}\"}}", Json.Escape(ex.Message));
            }

            // Build JSON output
            var sb = new StringBuilder();
            sb.Append("{\"success\":true,\"consultations\":[");
            for (int i = 0; i < consultations.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.AppendFormat("{{\"department\":\"{0}\",\"content\":\"{1}\"}}", Json.Escape(consultations[i][0]), Json.Escape(consultations[i][1]));
            }
            sb.Append("]}");
            return sb.ToString();
        }

        [STAThread]
        static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            _result = new Result();

            if (args.Length == 0)
            {
                _result.Message = "Usage: EmrHelper.exe --probe | --json <path> | --extract-record <ptNo> [--injury-date <date>] | --extract-consultation";
                Console.WriteLine(_result.ToJson());
                return 1;
            }

            bool probeOnly = false;
            string jsonPath = null;
            string extractRecordPtNo = null;
            string extractInjuryDate = null;
            bool extractConsultation = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--probe") probeOnly = true;
                else if (args[i] == "--diagnose") _diagnose = true;
                else if (args[i] == "--json" && i + 1 < args.Length) jsonPath = args[++i];
                else if (args[i] == "--extract-record" && i + 1 < args.Length) extractRecordPtNo = args[++i];
                else if (args[i] == "--injury-date" && i + 1 < args.Length) extractInjuryDate = args[++i];
                else if (args[i] == "--extract-consultation") extractConsultation = true;
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

            // ── New commands: extract-record, extract-consultation ──
            if (extractRecordPtNo != null)
            {
                string json = ExtractRecord(handles, extractRecordPtNo, extractInjuryDate);
                Console.WriteLine(json);
                return json.Contains("\"success\":true") ? 0 : 1;
            }

            if (extractConsultation)
            {
                string json = ExtractConsultation(handles);
                Console.WriteLine(json);
                return json.Contains("\"success\":true") ? 0 : 1;
            }

            // ── Legacy commands: probe, json (DRFMNG inject) ──

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
            SetField(doc, "txtMrec_Med_Pov_Cont", data.Get("txtMrecMedPovCont"));
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

                string examToDte = data.Get("rdoExamToDte");
                if (!string.IsNullOrEmpty(examToDte)) SetRadio(doc, "rdoExamToDte", examToDte);

                string idacDcsDte = data.Get("rdoIdacDcsDte");
                if (!string.IsNullOrEmpty(idacDcsDte)) SetRadio(doc, "rdoIdacDcsDte", idacDcsDte);
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

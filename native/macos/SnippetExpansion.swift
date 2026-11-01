import AppKit
import ApplicationServices
import Carbon

struct DateVariable: Codable { let name: String; let format: String }
struct Entry: Codable { let trigger: String; let replace: String; var dates: [DateVariable]? = nil }
func render(_ entry: Entry, now: Date = Date(), zone: TimeZone = .current) -> String? {
 var result = entry.replace
 let patterns: [Character: String] = ["Y":"yyyy", "y":"yy", "m":"MM", "d":"dd", "A":"EEEE", "a":"EEE", "B":"MMMM", "b":"MMM", "H":"HH", "I":"hh", "M":"mm", "S":"ss", "p":"a"]
 for variable in entry.dates ?? [] {
  var output = "", escaped = false
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.timeZone = zone
  for character in variable.format {
   if escaped {
    if character == "%" { output.append("%") }
    else if let pattern = patterns[character] { formatter.dateFormat = pattern; output += formatter.string(from: now) }
    else { return nil }
    escaped = false
   } else if character == "%" { escaped = true }
   else { output.append(character) }
  }
  if escaped { return nil }
  result = result.replacingOccurrences(of: "{{" + variable.name + "}}", with: output)
 }
 return result
}
func candidate(_ text: String, _ caret: Int, _ entries: [Entry]) -> Entry? {
 let value = text as NSString
 guard caret >= 0, caret <= value.length else { return nil }
 let prefix = value.substring(to: caret)
 return entries.sorted { $0.trigger.utf16.count > $1.trigger.utf16.count }.first { prefix.hasSuffix($0.trigger) }
}
func confirmedTrigger(_ entry: Entry, text: String?, caret: CFRange?) -> Bool {
 guard let text = text, let caret = caret, caret.length == 0 else { return false }
 return candidate(text, caret.location, [entry]) != nil
}
// Tracks only suffixes that are prefixes of configured shortcuts, never prose.
struct ShortcutTracker {
 var prefix = ""
 mutating func reset() { prefix = "" }
 mutating func append(_ characters: String, entries: [Entry]) -> Entry? {
  let eligible = entries.filter { $0.trigger.utf8.allSatisfy { $0 >= 33 && $0 <= 126 } }
  let value = String((prefix + characters).suffix(64))
  if let match = eligible.sorted(by: { $0.trigger.count > $1.trigger.count }).first(where: { value.hasSuffix($0.trigger) }) {
   reset(); return match
  }
  prefix = ""
  for length in stride(from: min(value.count, 64), through: 1, by: -1) {
   let suffix = String(value.suffix(length))
   if eligible.contains(where: { $0.trigger.hasPrefix(suffix) }) { prefix = suffix; break }
  }
  return nil
 }
}
if CommandLine.arguments.contains("--self-test") {
 let entries = [Entry(trigger: ";hi", replace: "Hello\nWorld")]
 precondition(candidate("😀 ;hi", 6, entries)?.replace == "Hello\nWorld")
 precondition(candidate(";hi!", 4, entries) == nil)
 precondition(candidate(";hi", 99, entries) == nil)
 let date = ISO8601DateFormatter().date(from: "2026-11-01T00:00:00Z")!
 let dated = Entry(trigger: ":today", replace: "{{today}}", dates: [DateVariable(name: "today", format: "%A, %d %b %Y")])
 precondition(render(dated, now: date, zone: TimeZone(secondsFromGMT: 28800)!) == "Sunday, 01 Nov 2026")
 precondition(render(dated, now: date.addingTimeInterval(86400), zone: TimeZone(secondsFromGMT: 28800)!) == "Monday, 02 Nov 2026")
 precondition(confirmedTrigger(dated, text: "existing text", caret: CFRange(location: 13, length: 0)) == false)
 precondition(confirmedTrigger(dated, text: nil, caret: nil) == false)
 precondition(confirmedTrigger(dated, text: ":today", caret: CFRange(location: 6, length: 1)) == false)
 precondition(confirmedTrigger(dated, text: "😀 :today!", caret: CFRange(location: 9, length: 0)))
 var tracker = ShortcutTracker()
 for key in [":", "t", "o", "d", "a"] { precondition(tracker.append(key, entries: [dated]) == nil) }
 precondition(tracker.append("y", entries: [dated])?.trigger == ":today", "Typed shortcut must match without AX text")
 precondition(tracker.prefix.isEmpty)
 _ = tracker.append(":to", entries: [dated]); tracker.reset()
 precondition(tracker.append("day", entries: [dated]) == nil, "Navigation/focus reset must prevent stale deletion")
 _ = tracker.append("private unrelated text", entries: [dated])
 precondition(tracker.prefix.isEmpty, "Unrelated text must not be retained")
 _ = tracker.append("::tod", entries: [dated])
 precondition(tracker.append("ay", entries: [dated])?.trigger == ":today")
 print("Native matching and date tests passed")
 exit(0)
}
func report(_ running: Bool, _ problem: String = "") {
 let data = try! JSONSerialization.data(withJSONObject: ["running": running, "problem": problem])
 FileHandle.standardOutput.write(data + Data([10]))
}
let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
guard AXIsProcessTrustedWithOptions(options) else {
 report(false, "Allow Snippet Editor for Espanso in System Settings → Privacy & Security → Accessibility, then turn expansion on again.")
 exit(2)
}
var entries: [Entry] = []
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
 var result: CFTypeRef?
 return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
func writable(_ element: AXUIElement, _ name: String) -> Bool {
 var result: DarwinBoolean = false
 return AXUIElementIsAttributeSettable(element, name as CFString, &result) == .success && result.boolValue
}
func selection(_ element: AXUIElement) -> CFRange? {
 guard let value = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
 var range = CFRange()
 return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}
func restoreCaret(_ element: AXUIElement, _ original: CFRange, _ expected: CFRange, _ text: String) {
 let system = AXUIElementCreateSystemWide()
 guard let focused = attribute(system, kAXFocusedUIElementAttribute), CFEqual(focused, element),
       let selected = selection(element), selected.location == expected.location, selected.length == expected.length,
       attribute(element, kAXValueAttribute) as? String == text else { return }
 var range = original
 if let value = AXValueCreate(.cfRange, &range) { _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) }
}
func expand(_ event: NSEvent) {
 report(true, "Keyboard event received; checking focused field.")
 guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(),
       event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
       let characters = event.characters, !characters.isEmpty,
       characters.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.value < 0xF700 }) else { report(true, "Key skipped: secure input, modifier, or non-text key."); return }
 let system = AXUIElementCreateSystemWide()
 guard let focused = attribute(system, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() else { report(true, "No accessible focused field."); return }
 let element = focused as! AXUIElement
 guard let role = attribute(element, kAXRoleAttribute) as? String, [kAXTextFieldRole, kAXTextAreaRole].contains(role),
       attribute(element, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { report(true, "The focused element is not an accessible text field."); return }
 guard writable(element, kAXSelectedTextRangeAttribute) else { report(true, "This text field does not allow caret selection through Accessibility."); return }
 guard let text = attribute(element, kAXValueAttribute) as? String, text.utf16.count <= 1000000 else { report(true, "This field does not expose readable text, or its text is too long."); return }
 guard let range = selection(element), range.length == 0 else { report(true, "This field does not expose a caret, or text is selected."); return }
 guard let entry = candidate(text, range.location, entries) else { report(true, "Readable field and caret; no shortcut matches before the caret."); return }
 guard entry.trigger.hasSuffix(characters), let replacement = render(entry) else { report(true, "Shortcut found, but the final key or date template did not match."); return }
 guard writable(element, kAXSelectedTextAttribute) else { report(true, "Shortcut matched, but this field does not support replacing selected text."); return }
 // Recheck focus and selection immediately before changing either. Never send
 // delete/return keystrokes or copy private text to the clipboard.
 guard let current = attribute(system, kAXFocusedUIElementAttribute), CFEqual(current, element),
       let now = selection(element), now.location == range.location, now.length == 0,
       attribute(element, kAXValueAttribute) as? String == text else { report(true, "Edit cancelled: focus, caret, or text changed."); return }
 var replaceRange = CFRange(location: range.location - entry.trigger.utf16.count, length: entry.trigger.utf16.count)
 guard let target = AXValueCreate(.cfRange, &replaceRange),
       AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, target) == .success else { report(true, "This field rejected the shortcut selection."); return }
 // Ensure the application honoured the selection before writing.
 guard let selected = selection(element), selected.location == replaceRange.location, selected.length == replaceRange.length,
       attribute(element, kAXSelectedTextAttribute) as? String == entry.trigger,
       let stillFocused = attribute(system, kAXFocusedUIElementAttribute), CFEqual(stillFocused, element) else {
  restoreCaret(element, range, replaceRange, text)
  report(true, "This field did not confirm the shortcut selection.")
  return
 }
 let result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, replacement as CFString)
 let expected = (text as NSString).replacingCharacters(in: NSRange(location: replaceRange.location, length: replaceRange.length), with: replacement)
 if attribute(element, kAXValueAttribute) as? String == expected {
  report(true, "Shortcut expanded successfully.")
 } else {
  restoreCaret(element, range, replaceRange, text)
  report(true, result == .success ? "This field accepted the edit but its text did not match the expected result." : "This field rejected text replacement.")
 }
}
// Compatibility path: recognize actual key-down sequences without requiring a
// writable AX range. Readable text and a caret remain mandatory before deletion. Keep only configured ASCII shortcut prefixes in memory.
let eventMarker: Int64 = 0x534E4950504554
var tracker = ShortcutTracker()
var trackedFocus: AXUIElement?
var pending: (entry: Entry, code: UInt16)?
var inputGeneration: UInt64 = 0
var deferredExpansion = false
func resetTracking() { inputGeneration &+= 1; deferredExpansion = false; tracker.reset(); pending = nil; trackedFocus = nil }
func focusedTextField() -> AXUIElement? {
 guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(),
       let focused = attribute(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute),
       CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
 let element = focused as! AXUIElement
 guard let role = attribute(element, kAXRoleAttribute) as? String,
       [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
       attribute(element, kAXSubroleAttribute) as? String != kAXSecureTextFieldSubrole else { return nil }
 return element
}
func keyboardReplacement(_ entry: Entry, in element: AXUIElement) -> Bool {
 // No Return, Tab, command chord or clipboard mutation on this path. Longer and
 // multiline snippets retain the verified Accessibility replacement path.
 guard let replacement = render(entry), replacement.utf16.count <= 512,
       replacement.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.value < 0xF700 }),
       confirmedTrigger(entry, text: attribute(element, kAXValueAttribute) as? String, caret: selection(element)) else {
  let valueLength = (attribute(element, kAXValueAttribute) as? String)?.utf16.count ?? -1
  let caret = selection(element)
  report(true, "Shortcut detected; field characters: \(valueLength), caret: \(caret?.location ?? -1), selection: \(caret?.length ?? -1). Shortcut not confirmed; no text deleted.")
  return false
 }
 var pid: pid_t = 0
 guard AXUIElementGetPid(element, &pid) == .success,
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
       let current = focusedTextField(), CFEqual(current, element) else { return false }
 // Prepare every event before sending any deletion. Tag generated events so they
 // can never feed back into the matcher. Unicode is sent one grapheme at a time.
 guard let source = CGEventSource(stateID: .privateState) else { return false }
 var events: [CGEvent] = []
 for _ in entry.trigger {
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false) else { return false }
  events += [down, up]
 }
 for character in replacement {
  let units = Array(String(character).utf16)
  guard units.count <= 20,
        let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
  down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
  up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
  events += [down, up]
 }
 guard let finalFocus = focusedTextField(), CFEqual(finalFocus, element),
       confirmedTrigger(entry, text: attribute(element, kAXValueAttribute) as? String, caret: selection(element)) else { return false }
 for event in events {
  event.flags = []
  event.setIntegerValueField(.eventSourceUserData, value: eventMarker)
  event.postToPid(pid)
 }
 report(true, "Shortcut sent using keyboard compatibility mode; check the target field.")
 return true
}
func observe(_ event: NSEvent) {
 if event.cgEvent?.getIntegerValueField(.eventSourceUserData) == eventMarker { return }
 if [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(event.type) { resetTracking(); return }
 if event.type == .flagsChanged {
  if !event.modifierFlags.intersection([.command, .control, .option]).isEmpty { resetTracking() }
  return
 }
 guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
       let field = focusedTextField() else { resetTracking(); return }
 if let previous = trackedFocus, !CFEqual(previous, field) { resetTracking() }
 trackedFocus = field
 guard let chars = event.characters, !chars.isEmpty,
       chars.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.value < 0xF700 }) else { resetTracking(); return }
 if event.type == .keyDown {
  inputGeneration &+= 1
  deferredExpansion = false
  pending = nil
  if !event.isARepeat, let entry = tracker.append(chars, entries: entries) { pending = (entry, event.keyCode) }
  else if event.isARepeat { resetTracking() }
 } else if event.type == .keyUp {
  if deferredExpansion { return }
  if let match = pending, match.code != event.keyCode { return }
  if let match = pending, match.code == event.keyCode {
   resetTracking()
   let generation = inputGeneration
   deferredExpansion = true
   // Chromium accessibility snapshots can lag key dispatch. Defer the read, not
   // deletion, and cancel if any key, click, modifier or focus transition intervenes.
   DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
    guard inputGeneration == generation else { return }
    deferredExpansion = false
    guard let current = focusedTextField(), CFEqual(current, field) else { return }
    if let replacement = render(match.entry), replacement.utf16.count <= 512,
       replacement.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) && $0.value < 0xF700 }) {
     _ = keyboardReplacement(match.entry, in: field)
    } else { expand(event) }
   }
   return
  }
  expand(event)
 }
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in resetTracking() }
guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown], handler: observe) else {
 report(false, "macOS could not start the text observer."); exit(3)
}
DispatchQueue.global().async {
 while let line = readLine() {
  guard let data = line.data(using: .utf8), let next = try? JSONDecoder().decode([Entry].self, from: data) else { continue }
  DispatchQueue.main.async { resetTracking(); entries = next; report(true) }
 }
 exit(0)
}
let permissionTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
 if !AXIsProcessTrusted() { report(false, "Accessibility permission was removed. Expansion has stopped."); exit(4) }
}
application.run()
NSEvent.removeMonitor(monitor)

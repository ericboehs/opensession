import AVFoundation
import Foundation
import Speech

private enum InputCommand: UInt8 {
    case audio = 1
    case stop = 2
}

private final class DictationHelper {
    private let sampleRate: Double
    private let language: String
    private let recognizer: SFSpeechRecognizer?
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var isStopping = false
    private var didFinish = false

    init(sampleRate: Double, language: String) {
        self.sampleRate = sampleRate
        self.language = language
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
    }

    func start() {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            startRecognition()
        case .notDetermined:
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == .authorized {
                        self.startRecognition()
                    } else {
                        self.fail("speech recognition permission was denied")
                    }
                }
            }
        case .denied:
            fail("speech recognition permission was denied")
        case .restricted:
            fail("speech recognition is restricted")
        @unknown default:
            fail("speech recognition is unavailable")
        }
    }

    private func startRecognition() {
        guard let recognizer, recognizer.isAvailable else {
            fail("speech recognition is unavailable")
            return
        }
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        request.contextualStrings = [
            "Open Session", "Tella", "GitHub", "pull request", "worktree", "sandbox",
        ]
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, !self.didFinish else { return }
                if let result {
                    self.latest = result.bestTranscription.formattedString
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    if !self.latest.isEmpty {
                        self.emit(type: result.isFinal ? "final" : "text", text: self.latest)
                    }
                    if result.isFinal {
                        self.finish()
                        return
                    }
                }
                if let error {
                    if self.isStopping, !self.latest.isEmpty {
                        self.emit(type: "final", text: self.latest)
                        self.finish()
                    } else {
                        self.fail(error.localizedDescription)
                    }
                }
            }
        }
        emit(type: "ready")
        readInput()
    }

    private func readInput() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let input = FileHandle.standardInput
            while let header = try? input.readExactly(5), header.count == 5 {
                let command = InputCommand(rawValue: header[0])
                let length = header.dropFirst().withUnsafeBytes { bytes in
                    UInt32(littleEndian: bytes.loadUnaligned(as: UInt32.self))
                }
                guard length <= 256 * 1_024 else {
                    DispatchQueue.main.async { self?.fail("audio frame was too large") }
                    return
                }
                let payload = length > 0 ? (try? input.readExactly(Int(length))) : Data()
                guard let payload, payload.count == Int(length) else {
                    DispatchQueue.main.async { self?.fail("audio stream ended early") }
                    return
                }
                guard let command else { continue }
                DispatchQueue.main.async {
                    guard let self, !self.didFinish else { return }
                    switch command {
                    case .audio:
                        self.append(payload)
                    case .stop:
                        self.stop()
                    }
                }
            }
        }
    }

    private func append(_ data: Data) {
        guard !isStopping, !data.isEmpty,
              let format = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: sampleRate,
                  channels: 1,
                  interleaved: false
              )
        else { return }
        let frameCount = data.count / MemoryLayout<Float>.size
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(
                  pcmFormat: format,
                  frameCapacity: AVAudioFrameCount(frameCount)
              ),
              let destination = buffer.floatChannelData?[0]
        else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)
        data.withUnsafeBytes { source in
            guard let baseAddress = source.baseAddress else { return }
            memcpy(destination, baseAddress, frameCount * MemoryLayout<Float>.size)
        }
        request.append(buffer)
    }

    private func stop() {
        guard !isStopping else { return }
        isStopping = true
        request.endAudio()
    }

    private func fail(_ message: String) {
        guard !didFinish else { return }
        emit(type: "error", message: message)
        finish(exitCode: 1)
    }

    private func finish(exitCode: Int32 = 0) {
        guard !didFinish else { return }
        didFinish = true
        task?.cancel()
        task = nil
        fflush(stdout)
        exit(exitCode)
    }

    private func emit(type: String, text: String? = nil, message: String? = nil) {
        var payload = ["type": type]
        if let text { payload["text"] = text }
        if let message { payload["message"] = message }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

private extension FileHandle {
    func readExactly(_ count: Int) throws -> Data {
        var data = Data()
        while data.count < count {
            guard let chunk = try read(upToCount: count - data.count), !chunk.isEmpty else { break }
            data.append(chunk)
        }
        return data
    }
}

@main
private enum Main {
    static func main() {
        guard CommandLine.arguments.count >= 3,
              let sampleRate = Double(CommandLine.arguments[1]),
              sampleRate >= 8_000,
              sampleRate <= 192_000
        else {
            exit(2)
        }
        let helper = DictationHelper(sampleRate: sampleRate, language: CommandLine.arguments[2])
        helper.start()
        RunLoop.main.run()
    }
}

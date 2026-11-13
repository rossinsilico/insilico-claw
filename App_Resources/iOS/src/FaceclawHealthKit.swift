import Foundation
import HealthKit
#if canImport(UIKit)
import UIKit
#endif

@objc(FaceclawHealthKit)
@objcMembers
public final class FaceclawHealthKit: NSObject {
    enum BridgeError: LocalizedError {
        case unavailable
        case protectedDataUnavailable
        case invalidDay
        case invalidRequestId
        case duplicateRequestId
        case invalidSamples(String)
        case writeNotAuthorized(String)
        case timedOut
        case serialization

        var errorDescription: String? {
            switch self {
            case .unavailable: return "Health data is unavailable on this device"
            case .protectedDataUnavailable: return "Unlock the iPhone to access health data"
            case .invalidDay: return "Day must be today or yesterday"
            case .invalidRequestId: return "A request ID is required"
            case .duplicateRequestId: return "That health request is already running"
            case .invalidSamples(let message): return message
            case .writeNotAuthorized(let type): return "Apple Health write access is not authorized for \(type)"
            case .timedOut: return "Apple Health did not respond in time"
            case .serialization: return "Health result could not be encoded"
            }
        }

        var code: String {
            switch self {
            case .unavailable: return "health_unavailable"
            case .protectedDataUnavailable: return "protected_data_unavailable"
            case .invalidDay: return "invalid_day"
            case .invalidRequestId: return "invalid_request_id"
            case .duplicateRequestId: return "duplicate_request_id"
            case .invalidSamples: return "invalid_samples"
            case .writeNotAuthorized: return "write_not_authorized"
            case .timedOut: return "query_timeout"
            case .serialization: return "serialization_failed"
            }
        }
    }

    enum RingSampleType: String, Decodable, CaseIterable {
        case heartRate
        case oxygenSaturation
        case stepCount
        case activeEnergyBurned
        case sleepAnalysis
    }

    struct RingSample: Decodable {
        let type: RingSampleType
        let value: Double
        let startMs: Double
        let endMs: Double
        let syncIdentifier: String
        let syncVersion: Int
    }

    private final class ActiveRequest {
        let day: String
        let interval: DateInterval
        let timeZone: String
        let completion: (String, String?) -> Void
        var queries: [HKQuery] = []
        var remaining = 0
        var metrics: [String: Any] = [
            "steps": NSNull(),
            "heartRate": NSNull(),
            "restingHeartRate": NSNull(),
            "hrv": NSNull(),
            "oxygenSaturation": NSNull(),
        ]
        var timeout: DispatchWorkItem?

        init(day: String, interval: DateInterval, timeZone: String,
             completion: @escaping (String, String?) -> Void) {
            self.day = day
            self.interval = interval
            self.timeZone = timeZone
            self.completion = completion
        }
    }

    private static let instance = FaceclawHealthKit()
    private let healthStore = HKHealthStore()
    private let stateQueue = DispatchQueue(label: "org.faceclaw.healthkit.requests")
    private var activeRequests: [String: ActiveRequest] = [:]

    @objc(shared)
    public static func shared() -> FaceclawHealthKit { instance }

    public func isAvailable() -> Bool { HKHealthStore.isHealthDataAvailable() }

    @objc(requestAccessWithCompletion:)
    public func requestAccess(completion: @escaping (String, String?) -> Void) {
        guard isAvailable() else { return complete(error: BridgeError.unavailable, completion: completion) }
        guard Self.protectedDataAvailable() else {
            return complete(error: BridgeError.protectedDataUnavailable, completion: completion)
        }
        healthStore.requestAuthorization(toShare: Self.writeTypes(), read: Self.readTypes()) { success, error in
            if let error {
                self.complete(error: error, code: "authorization_request_failed", completion: completion)
                return
            }
            let result: [String: Any] = [
                "ok": success,
                "requestCompleted": true,
                "readAuthorization": "not_disclosed_by_healthkit",
            ]
            self.complete(result: result, completion: completion)
        }
    }

    @objc(querySummary:requestId:completion:)
    public func querySummary(
        _ day: String,
        requestId: String,
        completion: @escaping (String, String?) -> Void
    ) {
        guard isAvailable() else { return complete(error: BridgeError.unavailable, completion: completion) }
        guard Self.protectedDataAvailable() else {
            return complete(error: BridgeError.protectedDataUnavailable, completion: completion)
        }
        guard !requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return complete(error: BridgeError.invalidRequestId, completion: completion)
        }
        let interval: DateInterval
        let calendar = Calendar.current
        do {
            interval = try Self.dayInterval(day: day, now: Date(), calendar: calendar)
        } catch {
            return complete(error: error, completion: completion)
        }

        let request = ActiveRequest(day: day, interval: interval, timeZone: calendar.timeZone.identifier,
                                    completion: completion)
        let timeout = DispatchWorkItem { [weak self] in self?.failRequest(requestId, error: BridgeError.timedOut) }
        request.timeout = timeout
        let registered = stateQueue.sync { () -> Bool in
            guard activeRequests[requestId] == nil else { return false }
            activeRequests[requestId] = request
            return true
        }
        guard registered else { return complete(error: BridgeError.duplicateRequestId, completion: completion) }

        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 8, execute: timeout)

        let predicate = HKQuery.predicateForSamples(withStart: interval.start, end: interval.end, options: [.strictStartDate])
        let queries: [(String, HKQuery)] = [
            ("steps", stepsQuery(predicate: predicate, requestId: requestId)),
            ("heartRate", latestQuery(.heartRate, unit: Self.beatsPerMinute, predicate: predicate, requestId: requestId)),
            ("restingHeartRate", latestQuery(.restingHeartRate, unit: Self.beatsPerMinute, predicate: predicate, requestId: requestId)),
            ("hrv", latestQuery(.heartRateVariabilitySDNN, unit: .secondUnit(with: .milli), predicate: predicate, requestId: requestId)),
            ("oxygenSaturation", latestQuery(.oxygenSaturation, unit: .percent(), predicate: predicate, requestId: requestId)),
        ]
        stateQueue.sync {
            guard activeRequests[requestId] === request else { return }
            request.queries = queries.map(\.1)
            request.remaining = queries.count
            queries.forEach { healthStore.execute($0.1) }
        }
    }

    @objc(cancelRequest:)
    public func cancelRequest(_ requestId: String) {
        let request = stateQueue.sync { activeRequests.removeValue(forKey: requestId) }
        guard let request else { return }
        request.timeout?.cancel()
        request.queries.forEach(healthStore.stop)
        complete(error: NSError(domain: "FaceclawHealthKit", code: NSUserCancelledError,
                                userInfo: [NSLocalizedDescriptionKey: "Health request cancelled"]),
                 code: "cancelled", completion: request.completion)
    }

    @objc(writeRingSamples:requestId:completion:)
    public func writeRingSamples(
        _ json: String,
        requestId: String,
        completion: @escaping (String, String?) -> Void
    ) {
        guard isAvailable() else { return complete(error: BridgeError.unavailable, completion: completion) }
        guard !requestId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return complete(error: BridgeError.invalidRequestId, completion: completion)
        }
        let records: [RingSample]
        do {
            records = try Self.validatedRingSamples(json: json, now: Date())
        } catch {
            return complete(error: error, completion: completion)
        }

        for record in records {
            let type = Self.sampleType(for: record.type)
            guard healthStore.authorizationStatus(for: type) == .sharingAuthorized else {
                return complete(error: BridgeError.writeNotAuthorized(record.type.rawValue), completion: completion)
            }
        }

        let device = HKDevice(name: "Even R1", manufacturer: "Even Realities", model: "R1",
                              hardwareVersion: nil, firmwareVersion: nil, softwareVersion: nil,
                              localIdentifier: nil, udiDeviceIdentifier: nil)
        let samples = records.map { Self.healthKitSample(for: $0, device: device) }
        healthStore.save(samples) { success, error in
            if let error {
                return self.complete(error: error, code: "save_failed", completion: completion)
            }
            self.complete(result: ["ok": success, "saveCompleted": success,
                                   "submittedCount": samples.count, "requestId": requestId],
                          completion: completion)
        }
    }

    static func dayInterval(day: String, now: Date, calendar: Calendar) throws -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start: Date
        switch day {
        case "today": start = today
        case "yesterday":
            guard let value = calendar.date(byAdding: .day, value: -1, to: today) else { throw BridgeError.invalidDay }
            start = value
        default: throw BridgeError.invalidDay
        }
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else { throw BridgeError.invalidDay }
        return DateInterval(start: start, end: end)
    }

    static func validatedRingSamples(json: String, now: Date) throws -> [RingSample] {
        let canonicalKeys: Set<String> = [
            "type", "value", "startMs", "endMs", "syncIdentifier", "syncVersion",
        ]
        guard let raw = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
              let objects = raw as? [[String: Any]],
              objects.allSatisfy({ Set($0.keys) == canonicalKeys }) else {
            throw BridgeError.invalidSamples("Ring samples must contain only canonical fields")
        }
        let records: [RingSample]
        do { records = try JSONDecoder().decode([RingSample].self, from: Data(json.utf8)) }
        catch { throw BridgeError.invalidSamples("Ring samples are not valid canonical JSON") }
        guard !records.isEmpty, records.count <= 2_000 else {
            throw BridgeError.invalidSamples("Ring export must contain between 1 and 2000 samples")
        }
        let earliest = Date(timeIntervalSince1970: 1_577_836_800).timeIntervalSince1970 * 1_000
        let latest = now.timeIntervalSince1970 * 1_000
        var identifiers = Set<String>()
        for record in records {
            guard record.value.isFinite, record.startMs.isFinite, record.endMs.isFinite else {
                throw BridgeError.invalidSamples("Ring sample values and dates must be finite")
            }
            guard record.startMs.rounded() == record.startMs, record.endMs.rounded() == record.endMs else {
                throw BridgeError.invalidSamples("Ring sample dates must use integer milliseconds")
            }
            guard record.startMs >= earliest, record.endMs >= record.startMs, record.endMs <= latest,
                  record.endMs - record.startMs <= 86_400_000 else {
                throw BridgeError.invalidSamples("Ring sample dates are invalid")
            }
            let durationMs = record.endMs - record.startMs
            switch record.type {
            case .heartRate:
                guard (20...300).contains(record.value), durationMs == 0 else {
                    throw BridgeError.invalidSamples("R1 heart-rate points must preserve their measurement timestamp and supported range")
                }
            case .oxygenSaturation:
                guard record.value > 0, record.value <= 1, durationMs == 0 else {
                    throw BridgeError.invalidSamples("R1 oxygen points must preserve their measurement timestamp and normalized value")
                }
            case .stepCount:
                guard record.value.rounded() == record.value, (0...4_095).contains(record.value),
                      durationMs == 600_000 else {
                    throw BridgeError.invalidSamples("R1 step buckets must contain an integer count over exactly ten minutes")
                }
            case .activeEnergyBurned:
                guard record.value.rounded() == record.value, (0...1_023).contains(record.value),
                      durationMs == 600_000 else {
                    throw BridgeError.invalidSamples("R1 energy buckets must contain integer kilocalories over exactly ten minutes")
                }
            case .sleepAnalysis:
                guard record.value.rounded() == record.value, Self.validSleepStageValues.contains(record.value),
                      durationMs > 0, durationMs.truncatingRemainder(dividingBy: 30_000) == 0 else {
                    throw BridgeError.invalidSamples("R1 sleep intervals must use a supported stage and whole 30-second boundaries")
                }
            }
            let identifier = record.syncIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !identifier.isEmpty, identifier.count <= 128, identifier == record.syncIdentifier,
                  record.syncVersion > 0, record.syncVersion <= Int(Int32.max),
                  identifiers.insert(identifier).inserted else {
                throw BridgeError.invalidSamples("Ring sample sync metadata is invalid")
            }
        }
        return records
    }

    static func metadata(for record: RingSample) -> [String: Any] {
        var result: [String: Any] = [
            HKMetadataKeySyncIdentifier: record.syncIdentifier,
            HKMetadataKeySyncVersion: record.syncVersion,
        ]
        switch record.type {
        case .heartRate, .oxygenSaturation:
            result["faceclaw.sampleKind"] = "ring-latest"
        case .stepCount, .activeEnergyBurned:
            result["faceclaw.sampleKind"] = "ten-minute-bucket"
        case .sleepAnalysis:
            result["faceclaw.sampleKind"] = "r1-sleep-stage"
        }
        return result
    }

    static func healthKitSample(for record: RingSample, device: HKDevice) -> HKSample {
        let start = Date(timeIntervalSince1970: record.startMs / 1_000)
        let end = Date(timeIntervalSince1970: record.endMs / 1_000)
        let metadata = metadata(for: record)
        if record.type == .sleepAnalysis {
            return HKCategorySample(type: categoryType(for: .sleepAnalysis), value: Int(record.value),
                                    start: start, end: end, device: device, metadata: metadata)
        }
        let unit: HKUnit
        switch record.type {
        case .heartRate: unit = beatsPerMinute
        case .oxygenSaturation: unit = .percent()
        case .stepCount: unit = .count()
        case .activeEnergyBurned: unit = .kilocalorie()
        case .sleepAnalysis: preconditionFailure("Sleep analysis is a category sample")
        }
        return HKQuantitySample(type: quantityType(for: record.type),
                                quantity: HKQuantity(unit: unit, doubleValue: record.value),
                                start: start, end: end, device: device, metadata: metadata)
    }

    private func stepsQuery(predicate: NSPredicate, requestId: String) -> HKStatisticsQuery {
        let type = Self.quantityType(for: HKQuantityTypeIdentifier.stepCount)
        return HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) {
            [weak self] _, statistics, error in
            guard let self else { return }
            if let error { return self.failRequest(requestId, error: error) }
            let value = statistics?.sumQuantity().map { ["value": $0.doubleValue(for: .count()), "unit": "count"] }
            self.record(requestId: requestId, metric: "steps", value: value)
        }
    }

    private func latestQuery(
        _ identifier: HKQuantityTypeIdentifier,
        unit: HKUnit,
        predicate: NSPredicate,
        requestId: String
    ) -> HKSampleQuery {
        let type = Self.quantityType(for: identifier)
        return HKSampleQuery(sampleType: type, predicate: predicate, limit: 1,
                             sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) {
            [weak self] _, samples, error in
            guard let self else { return }
            if let error { return self.failRequest(requestId, error: error) }
            let value = (samples?.first as? HKQuantitySample).map { sample -> [String: Any] in
                let source = sample.sourceRevision.source
                return [
                    "value": sample.quantity.doubleValue(for: unit),
                    "unit": Self.unitName(for: identifier),
                    "sampleAtMs": Self.milliseconds(sample.endDate),
                    "source": ["name": source.name, "bundleIdentifier": source.bundleIdentifier],
                ]
            }
            self.record(requestId: requestId, metric: Self.metricName(for: identifier), value: value)
        }
    }

    private func record(requestId: String, metric: String, value: [String: Any]?) {
        stateQueue.async {
            guard let request = self.activeRequests[requestId] else { return }
            request.metrics[metric] = value ?? NSNull()
            request.remaining -= 1
            guard request.remaining == 0 else { return }
            self.activeRequests.removeValue(forKey: requestId)
            request.timeout?.cancel()
            let queries = request.queries
            queries.forEach(self.healthStore.stop)
            let now = Date()
            let result: [String: Any] = [
                "ok": true,
                "source": "apple-health",
                "day": request.day,
                "timeZone": request.timeZone,
                "interval": ["startMs": Self.milliseconds(request.interval.start),
                             "endMs": Self.milliseconds(request.interval.end)],
                "queriedAtMs": Self.milliseconds(now),
                "metrics": request.metrics,
            ]
            self.completeSensitive(result: result, completion: request.completion)
        }
    }

    private func failRequest(_ requestId: String, error: Error) {
        let request = stateQueue.sync { activeRequests.removeValue(forKey: requestId) }
        guard let request else { return }
        request.timeout?.cancel()
        request.queries.forEach(healthStore.stop)
        complete(error: error, code: (error as? BridgeError)?.code ?? "query_failed", completion: request.completion)
    }

    private func complete(result: [String: Any], completion: @escaping (String, String?) -> Void) {
        do {
            let json = try Self.json(result)
            DispatchQueue.main.async { completion(json, nil) }
        } catch {
            complete(error: BridgeError.serialization, completion: completion)
        }
    }

    private func completeSensitive(result: [String: Any], completion: @escaping (String, String?) -> Void) {
        DispatchQueue.main.async {
            do {
                let json = try Self.encodedSensitiveResult(
                    result,
                    protectedDataAvailable: Self.protectedDataAvailable()
                )
                completion(json, nil)
            } catch {
                self.deliver(error: error, code: (error as? BridgeError)?.code, completion: completion)
            }
        }
    }

    private func complete(error: Error, code: String? = nil, completion: @escaping (String, String?) -> Void) {
        DispatchQueue.main.async { self.deliver(error: error, code: code, completion: completion) }
    }

    private func deliver(error: Error, code: String?, completion: @escaping (String, String?) -> Void) {
        let message = error.localizedDescription
        let payload: [String: Any] = [
            "ok": false,
            "error": ["code": code ?? (error as? BridgeError)?.code ?? "healthkit_failed", "message": message],
        ]
        let json = (try? Self.json(payload)) ?? "{\"ok\":false,\"error\":{\"code\":\"serialization_failed\"}}"
        completion(json, message)
    }

    private static func readTypes() -> Set<HKObjectType> {
        Set([HKQuantityTypeIdentifier.stepCount, .heartRate, .restingHeartRate,
             .heartRateVariabilitySDNN, .oxygenSaturation].map(quantityType(for:)))
    }

    static func writeTypes() -> Set<HKSampleType> {
        Set(RingSampleType.allCases.map(sampleType(for:)))
    }

    private static func quantityType(for identifier: HKQuantityTypeIdentifier) -> HKQuantityType {
        guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
            preconditionFailure("HealthKit quantity type is unavailable: \(identifier.rawValue)")
        }
        return type
    }

    private static func quantityType(for type: RingSampleType) -> HKQuantityType {
        switch type {
        case .heartRate: return quantityType(for: HKQuantityTypeIdentifier.heartRate)
        case .oxygenSaturation: return quantityType(for: HKQuantityTypeIdentifier.oxygenSaturation)
        case .stepCount: return quantityType(for: HKQuantityTypeIdentifier.stepCount)
        case .activeEnergyBurned: return quantityType(for: HKQuantityTypeIdentifier.activeEnergyBurned)
        case .sleepAnalysis: preconditionFailure("Sleep analysis is a category type")
        }
    }

    private static func categoryType(for identifier: HKCategoryTypeIdentifier) -> HKCategoryType {
        guard let type = HKObjectType.categoryType(forIdentifier: identifier) else {
            preconditionFailure("HealthKit category type is unavailable: \(identifier.rawValue)")
        }
        return type
    }

    private static func sampleType(for type: RingSampleType) -> HKSampleType {
        type == .sleepAnalysis ? categoryType(for: .sleepAnalysis) : quantityType(for: type)
    }

    private static let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
    private static let validSleepStageValues: Set<Double> = [2, 3, 4, 5]

    private static func metricName(for identifier: HKQuantityTypeIdentifier) -> String {
        switch identifier {
        case .heartRate: return "heartRate"
        case .restingHeartRate: return "restingHeartRate"
        case .heartRateVariabilitySDNN: return "hrv"
        case .oxygenSaturation: return "oxygenSaturation"
        default: return identifier.rawValue
        }
    }

    private static func unitName(for identifier: HKQuantityTypeIdentifier) -> String {
        switch identifier {
        case .heartRate, .restingHeartRate: return "bpm"
        case .heartRateVariabilitySDNN: return "ms"
        case .oxygenSaturation: return "fraction"
        default: return "unknown"
        }
    }

    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1_000).rounded())
    }

    private static func json(_ value: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let string = String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8) else {
            throw BridgeError.serialization
        }
        return string
    }

    static func encodedSensitiveResult(
        _ value: [String: Any],
        protectedDataAvailable: Bool
    ) throws -> String {
        guard protectedDataAvailable else { throw BridgeError.protectedDataUnavailable }
        return try json(value)
    }

    private static func protectedDataAvailable() -> Bool {
        #if canImport(UIKit)
        if Thread.isMainThread { return UIApplication.shared.isProtectedDataAvailable }
        return DispatchQueue.main.sync { UIApplication.shared.isProtectedDataAvailable }
        #else
        return true
        #endif
    }
}

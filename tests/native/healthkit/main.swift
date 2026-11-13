import Foundation
import HealthKit

@main
struct HealthKitContractTests {
    static func main() throws {
        let calendar = Calendar(identifier: .gregorian)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let today = try FaceclawHealthKit.dayInterval(day: "today", now: now, calendar: calendar)
        let yesterday = try FaceclawHealthKit.dayInterval(day: "yesterday", now: now, calendar: calendar)
        precondition(today.end == calendar.date(byAdding: .day, value: 1, to: today.start))
        precondition(yesterday.end == today.start)
        precondition((try? FaceclawHealthKit.dayInterval(day: "2026-11-11", now: now, calendar: calendar)) == nil)

        let valid = """
        [{"type":"heartRate","value":72,"startMs":1799996400000,"endMs":1799996400000,"syncIdentifier":"r1-heart-1","syncVersion":1},
         {"type":"oxygenSaturation","value":0.98,"startMs":1799996400000,"endMs":1799996400000,"syncIdentifier":"r1-oxygen-1","syncVersion":2},
         {"type":"stepCount","value":511,"startMs":1799998800000,"endMs":1799999400000,"syncIdentifier":"r1-steps-1","syncVersion":1},
         {"type":"activeEnergyBurned","value":47,"startMs":1799999400000,"endMs":1800000000000,"syncIdentifier":"r1-energy-1","syncVersion":1},
         {"type":"sleepAnalysis","value":2,"startMs":1799999820000,"endMs":1799999850000,"syncIdentifier":"r1-sleep-awake","syncVersion":1},
         {"type":"sleepAnalysis","value":5,"startMs":1799999850000,"endMs":1799999880000,"syncIdentifier":"r1-sleep-rem","syncVersion":1},
         {"type":"sleepAnalysis","value":3,"startMs":1799999880000,"endMs":1799999910000,"syncIdentifier":"r1-sleep-core","syncVersion":1},
         {"type":"sleepAnalysis","value":4,"startMs":1799999910000,"endMs":1799999940000,"syncIdentifier":"r1-sleep-deep","syncVersion":1}]
        """
        let samples = try FaceclawHealthKit.validatedRingSamples(json: valid, now: now)
        precondition(samples.count == 8)
        precondition(samples[0].type == .heartRate)
        precondition(samples[1].type == .oxygenSaturation)
        precondition(samples[2].type == .stepCount)
        precondition(samples[3].type == .activeEnergyBurned)
        precondition(samples[4].type == .sleepAnalysis)
        precondition(Int(samples[4].value) == HKCategoryValueSleepAnalysis.awake.rawValue)
        precondition(Int(samples[5].value) == HKCategoryValueSleepAnalysis.asleepREM.rawValue)
        precondition(Int(samples[6].value) == HKCategoryValueSleepAnalysis.asleepCore.rawValue)
        precondition(Int(samples[7].value) == HKCategoryValueSleepAnalysis.asleepDeep.rawValue)
        let heartMetadata = FaceclawHealthKit.metadata(for: samples[0])
        precondition(heartMetadata[HKMetadataKeySyncIdentifier] as? String == "r1-heart-1")
        precondition(heartMetadata[HKMetadataKeySyncVersion] as? Int == 1)
        precondition(heartMetadata["faceclaw.sampleKind"] as? String == "ring-latest")
        precondition(heartMetadata["faceclaw.aggregation"] == nil)
        let oxygenMetadata = FaceclawHealthKit.metadata(for: samples[1])
        precondition(oxygenMetadata["faceclaw.sampleKind"] as? String == "ring-latest")
        precondition(FaceclawHealthKit.metadata(for: samples[2])["faceclaw.sampleKind"] as? String == "ten-minute-bucket")
        precondition(FaceclawHealthKit.metadata(for: samples[3])["faceclaw.sampleKind"] as? String == "ten-minute-bucket")
        precondition(FaceclawHealthKit.metadata(for: samples[4])["faceclaw.sampleKind"] as? String == "r1-sleep-stage")

        let device = HKDevice(name: "Even R1", manufacturer: "Even Realities", model: "R1",
                              hardwareVersion: nil, firmwareVersion: nil, softwareVersion: nil,
                              localIdentifier: nil, udiDeviceIdentifier: nil)
        let healthKitSamples = samples.map { FaceclawHealthKit.healthKitSample(for: $0, device: device) }
        let heart = healthKitSamples[0] as? HKQuantitySample
        precondition(heart?.quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute())) == 72)
        let oxygen = healthKitSamples[1] as? HKQuantitySample
        precondition(oxygen?.quantity.doubleValue(for: .percent()) == 0.98)
        let steps = healthKitSamples[2] as? HKQuantitySample
        precondition(steps?.quantity.doubleValue(for: .count()) == 511)
        let energy = healthKitSamples[3] as? HKQuantitySample
        precondition(energy?.quantity.doubleValue(for: .kilocalorie()) == 47)
        for index in 4...7 {
            let sleep = healthKitSamples[index] as? HKCategorySample
            precondition(sleep?.value == Int(samples[index].value))
            precondition(sleep?.endDate.timeIntervalSince(sleep?.startDate ?? now) == 30)
        }

        let writeIdentifiers = Set(FaceclawHealthKit.writeTypes().map(\.identifier))
        precondition(writeIdentifiers == Set([
            HKQuantityTypeIdentifier.heartRate.rawValue,
            HKQuantityTypeIdentifier.oxygenSaturation.rawValue,
            HKQuantityTypeIdentifier.stepCount.rawValue,
            HKQuantityTypeIdentifier.activeEnergyBurned.rawValue,
            HKCategoryTypeIdentifier.sleepAnalysis.rawValue,
        ]))

        let invalidCases = [
            "[]",
            "[{\"type\":\"heartRateVariabilityRMSSD\",\"value\":42,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"temperatureVariation\",\"value\":0.2,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":0,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"oxygenSaturation\",\"value\":98,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"oxygenSaturation\",\"value\":0,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"oxygenSaturation\",\"value\":0.98,\"startMs\":1799999940000.5,\"endMs\":1799999941000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":0,\"endMs\":0,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1800000600000,\"endMs\":1800000600000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1800000000001,\"endMs\":1800000000001,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799999940000,\"endMs\":1799999939000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":0}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1,\"unexpected\":true}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"unit\":\"bpm\",\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"x\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799998200000,\"endMs\":1800000000000,\"syncIdentifier\":\"half-hour-average\",\"syncVersion\":1}]",
            "[{\"type\":\"heartRate\",\"value\":72,\"startMs\":1799996400000,\"endMs\":1800000000000,\"syncIdentifier\":\"hour-average\",\"syncVersion\":1}]",
            "[{\"type\":\"oxygenSaturation\",\"value\":0.98,\"startMs\":1799996400000,\"endMs\":1800000000000,\"syncIdentifier\":\"hour-oxygen-average\",\"syncVersion\":1}]",
            "[{\"type\":\"oxygenSaturation\",\"value\":0.98,\"startMs\":1799999880000,\"endMs\":1799999885000,\"syncIdentifier\":\"short-oxygen-average\",\"syncVersion\":1}]",
            "[{\"type\":\"stepCount\",\"value\":5,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"point-steps\",\"syncVersion\":1}]",
            "[{\"type\":\"stepCount\",\"value\":5,\"startMs\":1799999400000,\"endMs\":1799999940000,\"syncIdentifier\":\"nine-minute-steps\",\"syncVersion\":1}]",
            "[{\"type\":\"stepCount\",\"value\":1.5,\"startMs\":1799999400000,\"endMs\":1800000000000,\"syncIdentifier\":\"fractional-steps\",\"syncVersion\":1}]",
            "[{\"type\":\"stepCount\",\"value\":4096,\"startMs\":1799999400000,\"endMs\":1800000000000,\"syncIdentifier\":\"large-steps\",\"syncVersion\":1}]",
            "[{\"type\":\"activeEnergyBurned\",\"value\":1.5,\"startMs\":1799999400000,\"endMs\":1800000000000,\"syncIdentifier\":\"fractional-energy\",\"syncVersion\":1}]",
            "[{\"type\":\"activeEnergyBurned\",\"value\":1024,\"startMs\":1799999400000,\"endMs\":1800000000000,\"syncIdentifier\":\"large-energy\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":1,\"startMs\":1799999910000,\"endMs\":1799999940000,\"syncIdentifier\":\"asleep-unspecified\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":0,\"startMs\":1799999910000,\"endMs\":1799999940000,\"syncIdentifier\":\"in-bed\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":6,\"startMs\":1799999910000,\"endMs\":1799999940000,\"syncIdentifier\":\"invalid-stage\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":3.5,\"startMs\":1799999910000,\"endMs\":1799999940000,\"syncIdentifier\":\"fractional-stage\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":3,\"startMs\":1799999940000,\"endMs\":1799999940000,\"syncIdentifier\":\"point-stage\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":3,\"startMs\":1799999895000,\"endMs\":1799999940000,\"syncIdentifier\":\"45-second-stage\",\"syncVersion\":1}]",
            "[{\"type\":\"sleepAnalysis\",\"value\":3,\"startMs\":1799999970000,\"endMs\":1800000030000,\"syncIdentifier\":\"future-stage\",\"syncVersion\":1}]",
            "[{\"type\":\"stepCount\",\"value\":1,\"startMs\":1799998800000,\"endMs\":1799999400000,\"syncIdentifier\":\"duplicate\",\"syncVersion\":1},{\"type\":\"activeEnergyBurned\",\"value\":1,\"startMs\":1799999400000,\"endMs\":1800000000000,\"syncIdentifier\":\"duplicate\",\"syncVersion\":1}]",
        ]
        for (index, value) in invalidCases.enumerated() {
            precondition((try? FaceclawHealthKit.validatedRingSamples(json: value, now: now)) == nil,
                         "accepted invalid ring sample at index \(index)")
        }

        let payload: [String: Any] = ["ok": true, "metrics": ["heartRate": ["value": 72]]]
        precondition((try? FaceclawHealthKit.encodedSensitiveResult(payload, protectedDataAvailable: false)) == nil)
        let encoded = try FaceclawHealthKit.encodedSensitiveResult(payload, protectedDataAvailable: true)
        let decoded = try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [String: Any]
        precondition(decoded?["ok"] as? Bool == true)
    }
}

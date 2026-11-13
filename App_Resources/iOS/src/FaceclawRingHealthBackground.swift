import Foundation

protocol RingHealthBackgroundTask: AnyObject {
    var expirationHandler: (() -> Void)? { get set }
    func complete(success: Bool)
}

final class FaceclawRingHealthBackgroundCore {
    static let taskIdentifier = "com.rosspingatore.faceclawpilot.ring-health"
    static let budgetMs = 25_000.0
    static let minimumInterval: TimeInterval = 30 * 60

    private struct ActiveJob {
        let requestId: String
        let task: RingHealthBackgroundTask
    }

    private let available: Bool
    private let registerTask: (@escaping (RingHealthBackgroundTask) -> Void) -> Bool
    private let scheduleTask: (Date) throws -> Void
    private let cancelTask: (String) -> Void
    private let now: () -> Date
    private let makeRequestId: () -> String
    private let backgroundRefreshStatus: () -> String

    private var registrationAttempted = false
    private var registered = false
    private var enabled = false
    private var scheduled = false
    private var activeJob: ActiveJob?
    private var start: ((String, Double) -> Void)?
    private var cancel: ((String) -> Void)?
    private var lastOutcome: String?
    private var lastError: String?
    private var lastScheduledAt: Date?
    private var lastStartedAt: Date?
    private var lastFinishedAt: Date?

    init(
        available: Bool,
        registerTask: @escaping (@escaping (RingHealthBackgroundTask) -> Void) -> Bool,
        scheduleTask: @escaping (Date) throws -> Void,
        cancelTask: @escaping (String) -> Void,
        now: @escaping () -> Date,
        makeRequestId: @escaping () -> String,
        backgroundRefreshStatus: @escaping () -> String
    ) {
        self.available = available
        self.registerTask = registerTask
        self.scheduleTask = scheduleTask
        self.cancelTask = cancelTask
        self.now = now
        self.makeRequestId = makeRequestId
        self.backgroundRefreshStatus = backgroundRefreshStatus
    }

    func register(
        start: @escaping (String, Double) -> Void,
        cancel: @escaping (String) -> Void
    ) -> Bool {
        guard !registrationAttempted else { return registered }
        registrationAttempted = true
        self.start = start
        self.cancel = cancel
        guard available else {
            lastOutcome = "unavailable"
            lastError = "Background app refresh is unavailable"
            return false
        }

        registered = registerTask { [weak self] task in
            self?.receive(task)
        }
        guard registered else {
            lastOutcome = "registration_failed"
            lastError = "Background task registration was rejected"
            return false
        }
        scheduleIfNeeded()
        return true
    }

    func setEnabled(_ value: Bool) {
        guard enabled != value else {
            if value { scheduleIfNeeded() }
            return
        }
        enabled = value
        if value {
            scheduleIfNeeded()
            return
        }

        cancelTask(Self.taskIdentifier)
        scheduled = false
        guard let job = takeActiveJob() else { return }
        cancel?(job.requestId)
        job.task.complete(success: false)
        recordFinish(outcome: "cancelled", reschedule: false)
    }

    func complete(_ requestId: String, success: Bool) {
        guard activeJob?.requestId == requestId, let job = takeActiveJob() else { return }
        job.task.complete(success: success)
        recordFinish(outcome: success ? "succeeded" : "failed", reschedule: true)
    }

    func statusJson() -> String {
        let refreshStatus = backgroundRefreshStatus()
        var value: [String: Any] = [
            "registrationAttempted": registrationAttempted,
            "registered": registered,
            "enabled": enabled,
            "availability": refreshStatus,
            "frameworkAvailability": available ? "available" : "unavailable",
            "backgroundRefreshStatus": refreshStatus,
            "scheduled": scheduled,
            "active": activeJob != nil,
        ]
        value["lastOutcome"] = lastOutcome
        value["lastError"] = lastError
        value["lastScheduledAt"] = Self.timestamp(lastScheduledAt)
        value["lastStartedAt"] = Self.timestamp(lastStartedAt)
        value["lastFinishedAt"] = Self.timestamp(lastFinishedAt)
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else {
            return "{\"lastOutcome\":\"serialization_failed\"}"
        }
        return json
    }

    private func receive(_ task: RingHealthBackgroundTask) {
        scheduled = false
        guard enabled else {
            task.complete(success: false)
            lastOutcome = "disabled"
            lastFinishedAt = now()
            return
        }
        guard activeJob == nil else {
            task.complete(success: false)
            lastOutcome = "duplicate_launch"
            return
        }

        let requestId = makeRequestId()
        activeJob = ActiveJob(requestId: requestId, task: task)
        lastStartedAt = now()
        lastOutcome = "started"
        task.expirationHandler = { [weak self] in
            self?.expire(requestId)
        }
        guard activeJob?.requestId == requestId else { return }
        start?(requestId, Self.budgetMs)
    }

    private func expire(_ requestId: String) {
        guard activeJob?.requestId == requestId, let job = takeActiveJob() else { return }
        cancel?(requestId)
        job.task.complete(success: false)
        recordFinish(outcome: "expired", reschedule: true)
    }

    private func takeActiveJob() -> ActiveJob? {
        defer { activeJob = nil }
        return activeJob
    }

    private func recordFinish(outcome: String, reschedule: Bool) {
        lastOutcome = outcome
        lastError = nil
        lastFinishedAt = now()
        if reschedule { scheduleIfNeeded() }
    }

    private func scheduleIfNeeded() {
        guard available, registered, enabled, !scheduled, activeJob == nil else { return }
        let earliest = now().addingTimeInterval(Self.minimumInterval)
        do {
            try scheduleTask(earliest)
            scheduled = true
            lastScheduledAt = now()
            lastError = nil
        } catch {
            scheduled = false
            if lastOutcome == nil { lastOutcome = "scheduling_failed" }
            lastError = error.localizedDescription
        }
    }

    private static func timestamp(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        return ISO8601DateFormatter().string(from: date)
    }
}

#if os(iOS) && canImport(BackgroundTasks) && canImport(UIKit)
import BackgroundTasks
import UIKit

private final class FaceclawBGTask: RingHealthBackgroundTask {
    private let task: BGTask

    var expirationHandler: (() -> Void)? {
        didSet {
            guard let expirationHandler else {
                task.expirationHandler = nil
                return
            }
            task.expirationHandler = {
                DispatchQueue.main.async(execute: expirationHandler)
            }
        }
    }

    init(_ task: BGTask) {
        self.task = task
    }

    func complete(success: Bool) {
        task.setTaskCompleted(success: success)
    }
}

@objc(FaceclawRingHealthBackground)
@objcMembers
public final class FaceclawRingHealthBackground: NSObject {
    private static let instance = FaceclawRingHealthBackground()

    private lazy var core = FaceclawRingHealthBackgroundCore(
        available: true,
        registerTask: { launch in
            BGTaskScheduler.shared.register(
                forTaskWithIdentifier: FaceclawRingHealthBackgroundCore.taskIdentifier,
                using: nil
            ) { task in
                DispatchQueue.main.async {
                    launch(FaceclawBGTask(task))
                }
            }
        },
        scheduleTask: { earliest in
            let request = BGAppRefreshTaskRequest(
                identifier: FaceclawRingHealthBackgroundCore.taskIdentifier
            )
            request.earliestBeginDate = earliest
            try BGTaskScheduler.shared.submit(request)
        },
        cancelTask: { identifier in
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier)
        },
        now: Date.init,
        makeRequestId: { UUID().uuidString },
        backgroundRefreshStatus: {
            switch UIApplication.shared.backgroundRefreshStatus {
            case .available: return "available"
            case .denied: return "denied"
            case .restricted: return "restricted"
            @unknown default: return "unknown"
            }
        }
    )

    @objc(shared)
    public static func shared() -> FaceclawRingHealthBackground { instance }

    @objc(registerWithStart:cancel:)
    public func register(
        start: @escaping (String, Double) -> Void,
        cancel: @escaping (String) -> Void
    ) -> Bool {
        onMain { core.register(start: start, cancel: cancel) }
    }

    @objc(setEnabled:)
    public func setEnabled(_ enabled: Bool) {
        onMain { core.setEnabled(enabled) }
    }

    @objc(complete:success:)
    public func complete(_ requestId: String, success: Bool) {
        onMain { core.complete(requestId, success: success) }
    }

    @objc(statusJson)
    public func statusJson() -> String {
        onMain { core.statusJson() }
    }

    private func onMain<T>(_ operation: () -> T) -> T {
        if Thread.isMainThread { return operation() }
        return DispatchQueue.main.sync(execute: operation)
    }
}
#endif

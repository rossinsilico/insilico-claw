import Foundation

private final class TestTask: RingHealthBackgroundTask {
    var expirationHandler: (() -> Void)?
    var completions: [Bool] = []

    func complete(success: Bool) {
        completions.append(success)
    }
}

private final class ImmediatelyExpiringTask: RingHealthBackgroundTask {
    var expirationHandler: (() -> Void)? {
        didSet { expirationHandler?() }
    }
    var completions: [Bool] = []

    func complete(success: Bool) {
        completions.append(success)
    }
}

private enum TestError: Error {
    case scheduling
}

@main
struct RingBackgroundContractTests {
    static func main() throws {
        try registrationIsAttemptedOnlyOnce()
        try enabledSchedulingIsIdempotentAndDisableIsScoped()
        try completionAndExpirationFinishExactlyOnce()
        try staleCompletionCannotFinishANewerJob()
        try unavailableAndScheduleFailuresAreReported()
        try sameEnabledCallRetriesFailedScheduling()
        try synchronousLaunchCanStartBeforeRegistrationReturns()
        try synchronousExpirationDoesNotStartExpiredWork()
    }

    private static func registrationIsAttemptedOnlyOnce() throws {
        var registrations = 0
        let core = makeCore(register: { _ in
            registrations += 1
            return true
        })

        precondition(core.register(start: { _, _ in }, cancel: { _ in }))
        precondition(core.register(start: { _, _ in }, cancel: { _ in }))
        precondition(registrations == 1)
        let status = try decode(core.statusJson())
        precondition(status["registrationAttempted"] as? Bool == true)
        precondition(status["registered"] as? Bool == true)
        precondition(status["availability"] as? String == "available")
    }

    private static func enabledSchedulingIsIdempotentAndDisableIsScoped() throws {
        var scheduledDates: [Date] = []
        var cancelledIdentifiers: [String] = []
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let core = makeCore(
            schedule: { scheduledDates.append($0) },
            cancel: { cancelledIdentifiers.append($0) },
            now: { now }
        )
        precondition(core.register(start: { _, _ in }, cancel: { _ in }))

        core.setEnabled(true)
        core.setEnabled(true)
        precondition(scheduledDates == [now.addingTimeInterval(1_800)])

        core.setEnabled(false)
        core.setEnabled(false)
        precondition(cancelledIdentifiers == [FaceclawRingHealthBackgroundCore.taskIdentifier])
        let status = try decode(core.statusJson())
        precondition(status["enabled"] as? Bool == false)
        precondition(status["scheduled"] as? Bool == false)
    }

    private static func completionAndExpirationFinishExactlyOnce() throws {
        var launch: ((RingHealthBackgroundTask) -> Void)?
        var started: [(String, Double)] = []
        var cancelled: [String] = []
        var scheduled = 0
        var now = Date(timeIntervalSince1970: 2_000_000_000)
        let core = makeCore(
            register: { launch = $0; return true },
            schedule: { _ in scheduled += 1 },
            now: { now },
            requestId: { "job-1" }
        )
        precondition(core.register(
            start: { started.append(($0, $1)) },
            cancel: { cancelled.append($0) }
        ))
        core.setEnabled(true)
        let task = TestTask()
        launch?(task)
        precondition(started.count == 1)
        precondition(started[0].0 == "job-1")
        precondition(started[0].1 == 25_000)

        now = now.addingTimeInterval(10)
        core.complete("job-1", success: true)
        core.complete("job-1", success: false)
        task.expirationHandler?()
        precondition(task.completions == [true])
        precondition(cancelled.isEmpty)
        precondition(scheduled == 2)

        let expiryCore = makeCore(
            register: { launch = $0; return true },
            schedule: { _ in },
            requestId: { "job-expired" }
        )
        precondition(expiryCore.register(start: { _, _ in }, cancel: { cancelled.append($0) }))
        expiryCore.setEnabled(true)
        let expiredTask = TestTask()
        launch?(expiredTask)
        expiredTask.expirationHandler?()
        expiredTask.expirationHandler?()
        expiryCore.complete("job-expired", success: true)
        precondition(cancelled == ["job-expired"])
        precondition(expiredTask.completions == [false])
        let status = try decode(expiryCore.statusJson())
        precondition(status["lastOutcome"] as? String == "expired")
    }

    private static func staleCompletionCannotFinishANewerJob() throws {
        var launch: ((RingHealthBackgroundTask) -> Void)?
        var ids = ["old", "new"]
        let core = makeCore(
            register: { launch = $0; return true },
            requestId: { ids.removeFirst() }
        )
        precondition(core.register(start: { _, _ in }, cancel: { _ in }))
        core.setEnabled(true)
        let oldTask = TestTask()
        launch?(oldTask)
        core.complete("old", success: true)
        let newTask = TestTask()
        launch?(newTask)
        core.complete("old", success: false)
        precondition(newTask.completions.isEmpty)
        core.complete("new", success: true)
        precondition(newTask.completions == [true])
    }

    private static func unavailableAndScheduleFailuresAreReported() throws {
        var registrationCalls = 0
        let unavailable = makeCore(available: false, register: { _ in
            registrationCalls += 1
            return true
        })
        precondition(!unavailable.register(start: { _, _ in }, cancel: { _ in }))
        precondition(registrationCalls == 0)
        var status = try decode(unavailable.statusJson())
        precondition(status["availability"] as? String == "unavailable")
        precondition(status["frameworkAvailability"] as? String == "unavailable")
        precondition(status["lastOutcome"] as? String == "unavailable")

        let denied = makeCore(backgroundRefreshStatus: { "denied" })
        precondition(denied.register(start: { _, _ in }, cancel: { _ in }))
        status = try decode(denied.statusJson())
        precondition(status["frameworkAvailability"] as? String == "available")
        precondition(status["backgroundRefreshStatus"] as? String == "denied")
        precondition(status["availability"] as? String == "denied")

        let rejected = makeCore(register: { _ in false })
        precondition(!rejected.register(start: { _, _ in }, cancel: { _ in }))
        status = try decode(rejected.statusJson())
        precondition(status["lastOutcome"] as? String == "registration_failed")

        let scheduleFailure = makeCore(schedule: { _ in throw TestError.scheduling })
        precondition(scheduleFailure.register(start: { _, _ in }, cancel: { _ in }))
        scheduleFailure.setEnabled(true)
        status = try decode(scheduleFailure.statusJson())
        precondition(status["scheduled"] as? Bool == false)
        precondition(status["lastOutcome"] as? String == "scheduling_failed")
        precondition((status["lastError"] as? String)?.isEmpty == false)
    }

    private static func sameEnabledCallRetriesFailedScheduling() throws {
        var attempts = 0
        let core = makeCore(schedule: { _ in
            attempts += 1
            if attempts == 1 { throw TestError.scheduling }
        })
        precondition(core.register(start: { _, _ in }, cancel: { _ in }))
        core.setEnabled(true)
        core.setEnabled(true)
        precondition(attempts == 2)
        let status = try decode(core.statusJson())
        precondition(status["scheduled"] as? Bool == true)
        precondition(status["lastError"] == nil)
    }

    private static func synchronousLaunchCanStartBeforeRegistrationReturns() throws {
        let task = TestTask()
        var events: [String] = []
        let core = makeCore(register: { launch in
            events.append("register")
            launch(task)
            events.append("registered")
            return true
        })
        core.setEnabled(true)
        precondition(core.register(
            start: { _, _ in events.append("start") },
            cancel: { _ in events.append("cancel") }
        ))
        precondition(events == ["register", "start", "registered"])
        task.expirationHandler?()
        precondition(events == ["register", "start", "registered", "cancel"])
        precondition(task.completions == [false])
    }

    private static func synchronousExpirationDoesNotStartExpiredWork() throws {
        let task = ImmediatelyExpiringTask()
        var events: [String] = []
        let core = makeCore(register: { launch in
            events.append("register")
            launch(task)
            events.append("registered")
            return true
        })
        core.setEnabled(true)
        precondition(core.register(
            start: { _, _ in events.append("start") },
            cancel: { _ in events.append("cancel") }
        ))
        precondition(events == ["register", "cancel", "registered"])
        precondition(task.completions == [false])
    }

    private static func makeCore(
        available: Bool = true,
        register: @escaping (@escaping (RingHealthBackgroundTask) -> Void) -> Bool = { _ in true },
        schedule: @escaping (Date) throws -> Void = { _ in },
        cancel: @escaping (String) -> Void = { _ in },
        now: @escaping () -> Date = Date.init,
        requestId: @escaping () -> String = { "job" },
        backgroundRefreshStatus: (() -> String)? = nil
    ) -> FaceclawRingHealthBackgroundCore {
        FaceclawRingHealthBackgroundCore(
            available: available,
            registerTask: register,
            scheduleTask: schedule,
            cancelTask: cancel,
            now: now,
            makeRequestId: requestId,
            backgroundRefreshStatus: backgroundRefreshStatus ?? { available ? "available" : "unavailable" }
        )
    }

    private static func decode(_ value: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
    }
}

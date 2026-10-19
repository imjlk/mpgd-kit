import Foundation

private func expect(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(Data("NotificationSettingsURL: \(message)\n".utf8))
        exit(1)
    }
}

// iOS 16+ opens the app's notification settings.
expect(
    NotificationSettingsURL.string(
        notificationSettingsAvailable: true,
        notificationSettings: "app-settings:notifications",
        appSettings: "app-settings:"
    ) == "app-settings:notifications",
    "iOS 16 and later must open the notification settings"
)
// Earlier versions fall back to the app's settings page.
expect(
    NotificationSettingsURL.string(
        notificationSettingsAvailable: false,
        notificationSettings: "app-settings:notifications",
        appSettings: "app-settings:"
    ) == "app-settings:",
    "iOS 15 must fall back to the app settings"
)
// A blank notification settings URL never wins over the app settings.
expect(
    NotificationSettingsURL.string(
        notificationSettingsAvailable: true,
        notificationSettings: "",
        appSettings: "app-settings:"
    ) == "app-settings:",
    "a blank notification settings URL must fall back to the app settings"
)
print("NotificationSettingsURL conformance passed.")

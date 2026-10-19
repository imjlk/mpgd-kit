import Foundation

/// The settings URL `openNotificationSettings` opens, chosen without UIKit so
/// the choice is testable. iOS 16 and later open this app's notification
/// settings (`UIApplication.openNotificationSettingsURLString`); earlier
/// versions open the app's settings page (`UIApplication.openSettingsURLString`),
/// where notifications are one entry.
enum NotificationSettingsURL {
    static func string(
        notificationSettingsAvailable: Bool,
        notificationSettings: String,
        appSettings: String
    ) -> String {
        notificationSettingsAvailable && !notificationSettings.isEmpty ? notificationSettings : appSettings
    }
}

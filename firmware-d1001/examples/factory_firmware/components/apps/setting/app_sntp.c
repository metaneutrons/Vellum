/*
 * SPDX-FileCopyrightText: 2023 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Unlicense OR CC0-1.0
 */
#include <string.h>
#include <time.h>
#include <sys/time.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "esp_sleep.h"
#include "esp_sntp.h"
#include "bsp_pcf8563.h"

#define TIMEZONE        "CST-8"
#define SERVER_NAME_0   "ntp.aliyun.com"
#define SERVER_NAME_1   "time.asia.apple.com"
#define SERVER_NAME_2   "pool.ntp.org"

static const char *TAG = "sntp";

extern pcf8563_handle_t pcf8563;

static void obtain_time(void);
static void initialize_sntp(void);

#ifdef CONFIG_SNTP_TIME_SYNC_METHOD_CUSTOM
void sntp_sync_time(struct timeval *tv)
{
    settimeofday(tv, NULL);
    ESP_LOGI(TAG, "Time is synchronized from custom code");
    sntp_set_sync_status(SNTP_SYNC_STATUS_COMPLETED);
}
#endif

static void time_sync_notification_cb(struct timeval *tv)
{
    ESP_LOGI(TAG, "Notification of a time synchronization event, sec=%lu", (uint32_t)tv->tv_sec);
    settimeofday(tv, NULL);
}

void app_sntp_init(void)
{
    static bool sntp_initialized = false;
    time_t now;
    struct tm timeinfo;

    if (sntp_initialized) {
        return;
    }

    time(&now);
    localtime_r(&now, &timeinfo);

    // Set timezone to CST-0 Time
    setenv("TZ", "CST-0", 1);
    tzset();

    // Is time set? If not, tm_year will be (1970 - 1900).
    // if (timeinfo.tm_year < (2016 - 1900)) {
    if (timeinfo.tm_year >= 0) {
        ESP_LOGI(TAG, "Time is not set yet. Connecting to WiFi and getting time over NTP.");
        obtain_time();
        // update 'now' variable with current time
        time(&now);
    }
#ifdef CONFIG_SNTP_TIME_SYNC_METHOD_SMOOTH
    else {
        // add 500 ms error to the current system time.
        // Only to demonstrate a work of adjusting method!
        {
            ESP_LOGI(TAG, "Add a error for test adjtime");
            struct timeval tv_now;
            gettimeofday(&tv_now, NULL);
            int64_t cpu_time = (int64_t)tv_now.tv_sec * 1000000L + (int64_t)tv_now.tv_usec;
            int64_t error_time = cpu_time + 500 * 1000L;
            struct timeval tv_error = {.tv_sec = error_time / 1000000L, .tv_usec = error_time % 1000000L};
            settimeofday(&tv_error, NULL);
        }

        ESP_LOGI(TAG, "Time was set, now just adjusting it. Use SMOOTH SYNC method.");
        obtain_time();
        // update 'now' variable with current time
        time(&now);
    }
#endif

    char strftime_buf[64];
    localtime_r(&now, &timeinfo);
    strftime(strftime_buf, sizeof(strftime_buf), "%c", &timeinfo);
    ESP_LOGI(TAG, "The current date/time in CST-0 is: %s", strftime_buf);

    ESP_LOGI(TAG, "%d-%d-%d @%d %d:%d:%d ", timeinfo.tm_year + 1900, timeinfo.tm_mon, timeinfo.tm_mday, timeinfo.tm_wday, 
                                                timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
    rtc_datatime_t datetime = { 0 };
    datetime.year = timeinfo.tm_year + 1900;
    datetime.month = timeinfo.tm_mon;
    datetime.day = timeinfo.tm_mday;
    datetime.week = timeinfo.tm_wday;
    datetime.hour = timeinfo.tm_hour; 
    datetime.minute = timeinfo.tm_min;
    datetime.second = timeinfo.tm_sec;
    esp_err_t ret = bsp_pcf8563_set_datatime(&pcf8563, &datetime);
    if(ret == ESP_OK) {
        ESP_LOGI(TAG, "Set rtc ok");
    }
    else {
        ESP_LOGI(TAG, "Set rtc fail");
    }

    if (sntp_get_sync_mode() == SNTP_SYNC_MODE_SMOOTH) {
        struct timeval outdelta;
        while (sntp_get_sync_status() == SNTP_SYNC_STATUS_IN_PROGRESS) {
            adjtime(NULL, &outdelta);
            ESP_LOGI(TAG, "Waiting for adjusting time ... outdelta = %li sec: %li ms: %li us",
                     (long)outdelta.tv_sec,
                     outdelta.tv_usec / 1000,
                     outdelta.tv_usec % 1000);
            vTaskDelay(1000 / portTICK_PERIOD_MS);
        }
    }

    sntp_initialized = true;
}

static void obtain_time(void)
{
    initialize_sntp();

    // wait for time to be set
    time_t now = 0;
    struct tm timeinfo = {0};
    int retry = 0;
    const int retry_count = 10;

    while (sntp_get_sync_status() == SNTP_SYNC_STATUS_RESET && ++retry < retry_count) {
        ESP_LOGI(TAG, "Waiting for system time to be set... (%d/%d)", retry, retry_count);
        vTaskDelay(2000 / portTICK_PERIOD_MS);
    }
    time(&now);
    localtime_r(&now, &timeinfo);
}

static void initialize_sntp(void)
{
    ESP_LOGI(TAG, "Initializing SNTP");
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, SERVER_NAME_0);
    esp_sntp_setservername(1, SERVER_NAME_1);
    esp_sntp_setservername(2, SERVER_NAME_2);
    esp_sntp_set_time_sync_notification_cb(time_sync_notification_cb);
#ifdef CONFIG_SNTP_TIME_SYNC_METHOD_SMOOTH
    esp_sntp_set_sync_mode(SNTP_SYNC_MODE_SMOOTH);
#endif
    esp_sntp_init();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Fabian Schmieder. All rights reserved.
/**
 * @file vellum_serial.c
 * @brief Improv WiFi Serial protocol + interactive console.
 *
 * Runs on the model's primary console (native USB-Serial-JTAG on E1001 and
 * D1001; UART0 through the onboard CH34x on E1002/E1003). One byte stream carries
 * two things, so line-ending translation MUST be disabled (see serial_task) or
 * the binary frames get corrupted:
 * - Improv WiFi protocol (binary packets) for browser-based WiFi config
 * - Text console commands for developer/power-user config
 */

#include "vellum_serial.h"
#include "nvs_manager.h"
#include "wifi_manager.h"
#include "transport_policy.h"
#include "board.h"

#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_console.h"
#include "esp_vfs_dev.h"
#include "driver/uart.h"
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
#include "driver/usb_serial_jtag_vfs.h"
#elif CONFIG_ESP_CONSOLE_UART
#include "driver/uart_vfs.h"
#endif
#include "linenoise/linenoise.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "serial";

/* ── Improv WiFi Serial Protocol ──────────────────────────────── */

#define IMPROV_HEADER "IMPROV"
#define IMPROV_VERSION 1

/* Packet types */
#define IMPROV_TYPE_CURRENT_STATE 0x01
#define IMPROV_TYPE_ERROR_STATE   0x02
#define IMPROV_TYPE_RPC_COMMAND   0x03
#define IMPROV_TYPE_RPC_RESULT    0x04

/* RPC commands */
#define IMPROV_CMD_WIFI_SETTINGS  0x01
#define IMPROV_CMD_GET_STATE      0x02
#define IMPROV_CMD_GET_DEVICE_INFO 0x03
#define IMPROV_CMD_SCAN_WIFI      0x04

/* States */
#define IMPROV_STATE_READY        0x02
#define IMPROV_STATE_PROVISIONING 0x03
#define IMPROV_STATE_PROVISIONED  0x04

/* Errors */
#define IMPROV_ERROR_NONE         0x00
#define IMPROV_ERROR_INVALID_RPC  0x01
#define IMPROV_ERROR_UNKNOWN_CMD  0x02
#define IMPROV_ERROR_UNABLE_CONNECT 0x03
/* Vellum protocol extension: the firmware build policy rejected server URL. */
#define IMPROV_ERROR_INSECURE_URL   0x04

static uint8_t s_improv_state = IMPROV_STATE_READY;

static bool provisioning_url_allowed(const char *url)
{
    bool allow_private_http = false;
#ifdef CONFIG_VELLUM_ALLOW_INSECURE_PRIVATE_HTTP
    allow_private_http = true;
#endif
    return !url || !url[0] || vellum_transport_url_allowed(url, allow_private_http);
}

static void improv_send_packet(uint8_t type, const uint8_t *data, uint8_t len)
{
    uint8_t pkt[256];
    /* header(6)+ver+type+len = 9, payload = len, checksum = 1 → 10 + len. */
    if ((size_t)len + 10 > sizeof(pkt)) return;
    memcpy(pkt, IMPROV_HEADER, 6);
    pkt[6] = IMPROV_VERSION;
    pkt[7] = type;
    pkt[8] = len;
    if (len > 0 && data) memcpy(&pkt[9], data, len);

    uint8_t checksum = 0;
    for (int i = 0; i < 9 + len; i++) checksum += pkt[i];
    pkt[9 + len] = checksum;

    fwrite(pkt, 1, 10 + len, stdout);
    fflush(stdout);
}

static void improv_send_state(void)
{
    uint8_t state = s_improv_state;
    improv_send_packet(IMPROV_TYPE_CURRENT_STATE, &state, 1);
}

static void improv_send_error(uint8_t error)
{
    improv_send_packet(IMPROV_TYPE_ERROR_STATE, &error, 1);
}

static void improv_send_rpc_result(uint8_t cmd, const char **strings, int count)
{
    /* Payload must fit an Improv frame — improv_send_packet caps at 246 payload
     * bytes (pkt[256] minus the 10-byte header/checksum). Bound every write so a
     * long device-supplied string (e.g. a 256-byte redirect URL on the
     * WIFI_SETTINGS success path) can never overflow this buffer or the frame. */
    uint8_t buf[246];
    int pos = 0;
    buf[pos++] = cmd;

    int data_start = pos;
    pos++; /* placeholder for data length */

    for (int i = 0; i < count; i++) {
        int slen = strlen(strings[i]);
        if (slen > 255) slen = 255;
        if (pos + 1 + slen > (int)sizeof(buf)) break; /* drop strings that don't fit */
        buf[pos++] = (uint8_t)slen;
        memcpy(&buf[pos], strings[i], slen);
        pos += slen;
    }
    buf[data_start] = (uint8_t)(pos - data_start - 1);

    improv_send_packet(IMPROV_TYPE_RPC_RESULT, buf, (uint8_t)pos);
}

static void improv_handle_wifi_settings(const uint8_t *data, uint8_t len)
{
    if (len < 2) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }

    uint8_t ssid_len = data[0];
    if ((size_t)1 + ssid_len >= len) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }
    char ssid[33] = {0};
    memcpy(ssid, &data[1], ssid_len > 32 ? 32 : ssid_len);

    uint8_t pass_len = data[1 + ssid_len];
    /* The password bytes must lie within the received payload. */
    if ((size_t)2 + ssid_len + pass_len > len) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }
    char pass[65] = {0};
    if (pass_len > 0) memcpy(pass, &data[2 + ssid_len], pass_len > 64 ? 64 : pass_len);

    /* Optional positional strings: server URL, zero-touch token, NTP override,
     * then the provisioning client's current UTC Unix time. */
    char redirect[NVS_MAX_URL_LEN] = {0};
    char supplied_url[NVS_MAX_URL_LEN] = {0};
    char supplied_token[NVS_MAX_TOKEN_LEN] = {0};
    char supplied_ntp[NVS_MAX_NTP_SERVER_LEN] = {0};
    bool token_supplied = false;
    bool ntp_supplied = false;
    bool time_supplied = false;
    time_t supplied_time = 0;
    size_t pos = (size_t)2 + ssid_len + pass_len;
    if (pos < len) {
        uint8_t url_len = data[pos];
        if (pos + 1 + url_len > (size_t)len) {
            improv_send_error(IMPROV_ERROR_INVALID_RPC);
            return;
        }
        _Static_assert(NVS_MAX_URL_LEN >= 256, "url buffer must hold any uint8_t-length value + NUL");
        if (url_len > 0) memcpy(supplied_url, &data[pos + 1], url_len);
        if (!provisioning_url_allowed(supplied_url)) {
            ESP_LOGW(TAG, "Improv: server URL rejected by build policy");
            improv_send_error(IMPROV_ERROR_INSECURE_URL);
            return;
        }
        pos += 1 + url_len;

        if (pos < len) {
            uint8_t tok_len = data[pos];
            if (pos + 1 + tok_len > (size_t)len) {
                improv_send_error(IMPROV_ERROR_INVALID_RPC);
                return;
            }
            token_supplied = true;
            if (tok_len > 0) {
                memcpy(supplied_token, &data[pos + 1],
                       tok_len >= NVS_MAX_TOKEN_LEN ? NVS_MAX_TOKEN_LEN - 1 : tok_len);
            }
            pos += 1 + tok_len;
        }

        if (pos < len) {
            uint8_t ntp_len = data[pos];
            _Static_assert(NVS_MAX_NTP_SERVER_LEN >= 256,
                           "NTP buffer must hold any uint8_t-length value + NUL");
            if (pos + 1 + ntp_len > (size_t)len) {
                improv_send_error(IMPROV_ERROR_INVALID_RPC);
                return;
            }
            ntp_supplied = true;
            if (ntp_len > 0) memcpy(supplied_ntp, &data[pos + 1], ntp_len);
            pos += 1 + ntp_len;
        }

        if (pos < len) {
            uint8_t time_len = data[pos];
            if (time_len == 0 || time_len > 20 || pos + 1 + time_len != (size_t)len) {
                improv_send_error(IMPROV_ERROR_INVALID_RPC);
                return;
            }
            char value[21] = {0};
            memcpy(value, &data[pos + 1], time_len);
            char *end = NULL;
            long long parsed = strtoll(value, &end, 10);
            if (!end || *end != '\0' || parsed < 1704067200LL || parsed > 4102444799LL) {
                improv_send_error(IMPROV_ERROR_INVALID_RPC);
                return;
            }
            supplied_time = (time_t)parsed;
            time_supplied = true;
            pos += 1 + time_len;
        }
    }

    if (pos != len) {
        improv_send_error(IMPROV_ERROR_INVALID_RPC);
        return;
    }

    ESP_LOGI(TAG, "Improv: WiFi credentials received — SSID: %s", ssid);

    s_improv_state = IMPROV_STATE_PROVISIONING;
    improv_send_state();
    improv_send_error(IMPROV_ERROR_NONE);

    /* Store and connect */
    nvs_manager_store_wifi(ssid, pass);
    if (token_supplied && supplied_token[0]) {
        nvs_manager_store_token(supplied_token);
        ESP_LOGI(TAG, "Improv: pre-provisioning token stored");
    }
    if (supplied_url[0]) {
        nvs_manager_store_server_url(supplied_url);
        snprintf(redirect, sizeof(redirect), "%s", supplied_url);
        ESP_LOGI(TAG, "Improv: Server URL: %s", supplied_url);
    }
    if (ntp_supplied) {
        nvs_manager_store_ntp_server(supplied_ntp);
        ESP_LOGI(TAG, "Improv: NTP server override %s", supplied_ntp[0] ? "stored" : "cleared");
    }
    if (time_supplied) {
        if (board_set_utc_time(supplied_time) == ESP_OK) {
            ESP_LOGI(TAG, "Improv: system time provisioned");
        } else {
            ESP_LOGW(TAG, "Improv: could not apply provisioned system time");
        }
    }

    if (wifi_manager_connect_station() == WIFI_RESULT_CONNECTED) {
        s_improv_state = IMPROV_STATE_PROVISIONED;
        improv_send_state();
        /* A repeat provisioning run may omit the optional URL. Preserve the
         * previously configured redirect so ESP Web Tools can still offer a
         * useful Visit Device action instead of hiding it unnecessarily. */
        if (redirect[0] == '\0') {
            nvs_manager_get_server_url(redirect, sizeof(redirect));
        }
        /* ESP Web Tools uses the first RPC result string as the optional
         * redirect for its “Visit Device” action. Never send an empty string:
         * the web component treats that as a present href (the current page),
         * rendering a dead link. Omitting the result cleanly hides the action
         * until a real device URL is available. */
        if (redirect[0] != '\0') {
            const char *result[] = { redirect };
            improv_send_rpc_result(IMPROV_CMD_WIFI_SETTINGS, result, 1);
        } else {
            improv_send_rpc_result(IMPROV_CMD_WIFI_SETTINGS, NULL, 0);
        }
        ESP_LOGI(TAG, "Improv: WiFi connected");
    } else {
        s_improv_state = IMPROV_STATE_READY;
        improv_send_error(IMPROV_ERROR_UNABLE_CONNECT);
        ESP_LOGW(TAG, "Improv: WiFi connection failed");
    }
}

static void improv_handle_device_info(void)
{
    const char *info[] = {
        "Vellum",
        CONFIG_VELLUM_FIRMWARE_VERSION,
        CONFIG_IDF_TARGET,
        CONFIG_VELLUM_DISPLAY_MODEL,
    };
    improv_send_rpc_result(IMPROV_CMD_GET_DEVICE_INFO, info, 4);
}

/* Improv SCAN_WIFI: one RPC_RESULT per network (ssid, rssi, auth-required),
 * then a final empty RPC_RESULT to terminate the list (Improv spec). */
static void improv_handle_scan_wifi(void)
{
    wifi_ap_info_t aps[20];
    int n = wifi_manager_scan(aps, 20);
    for (int i = 0; i < n; i++) {
        char rssi_str[8];
        snprintf(rssi_str, sizeof(rssi_str), "%d", aps[i].rssi);
        const char *strs[] = { aps[i].ssid, rssi_str, aps[i].open ? "NO" : "YES" };
        improv_send_rpc_result(IMPROV_CMD_SCAN_WIFI, strs, 3);
    }
    improv_send_rpc_result(IMPROV_CMD_SCAN_WIFI, NULL, 0);
}

static void improv_handle_rpc(const uint8_t *data, uint8_t len)
{
    if (len < 2) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }

    uint8_t cmd = data[0];
    uint8_t cmd_len = data[1];

    /* The declared command payload must fit within the bytes actually received;
     * never trust cmd_len on its own (it drove out-of-bounds reads before). */
    if ((size_t)2 + cmd_len > len) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }

    switch (cmd) {
        case IMPROV_CMD_WIFI_SETTINGS:
            improv_handle_wifi_settings(&data[2], cmd_len);
            break;
        case IMPROV_CMD_GET_STATE:
            improv_send_state();
            break;
        case IMPROV_CMD_GET_DEVICE_INFO:
            improv_handle_device_info();
            break;
        case IMPROV_CMD_SCAN_WIFI:
            improv_handle_scan_wifi();
            break;
        default:
            improv_send_error(IMPROV_ERROR_UNKNOWN_CMD);
            break;
    }
}

/* Check if incoming bytes are an Improv packet */
static bool improv_try_parse(const uint8_t *buf, int len)
{
    if (len < 10) return false;
    if (memcmp(buf, IMPROV_HEADER, 6) != 0) return false;
    if (buf[6] != IMPROV_VERSION) return false;

    uint8_t type = buf[7];
    uint8_t data_len = buf[8];
    if (len < 10 + data_len) return false;

    /* Verify checksum */
    uint8_t checksum = 0;
    for (int i = 0; i < 9 + data_len; i++) checksum += buf[i];
    if (checksum != buf[9 + data_len]) return false;

    if (type == IMPROV_TYPE_RPC_COMMAND) {
        improv_handle_rpc(&buf[9], data_len);
    }
    return true;
}

/* ── Console Commands ─────────────────────────────────────────── */

static int cmd_wifi(int argc, char **argv)
{
    if (argc < 3) {
        printf("Usage: wifi <ssid> <password> [server-url]\n");
        return 1;
    }
    if (argc >= 4 && !provisioning_url_allowed(argv[3])) {
        printf("Error: this firmware requires an https:// server URL. No settings were changed.\n");
        return 1;
    }
    nvs_manager_store_wifi(argv[1], argv[2]);
    printf("WiFi credentials stored.\n");
    if (argc >= 4) {
        nvs_manager_store_server_url(argv[3]);
        printf("Server URL stored: %s\n", argv[3]);
    }
    printf("Reboot to connect.\n");
    return 0;
}

static int cmd_server(int argc, char **argv)
{
    if (argc < 2) {
        char url[128];
        if (nvs_manager_get_server_url(url, sizeof(url)) == ESP_OK) {
            printf("Server: %s\n", url);
        } else {
            printf("Server: (not set, using mDNS discovery)\n");
        }
        return 0;
    }
    if (!provisioning_url_allowed(argv[1])) {
        printf("Error: this firmware requires an https:// server URL. No settings were changed.\n");
        return 1;
    }
    nvs_manager_store_server_url(argv[1]);
    printf("Server URL stored: %s\n", argv[1]);
    return 0;
}

static int cmd_token(int argc, char **argv)
{
    if (argc < 2) {
        printf("Usage: token <value>\n");
        return 1;
    }
    nvs_manager_store_token(argv[1]);
    printf("Device token stored.\n");
    return 0;
}

static int cmd_info(int argc, char **argv)
{
    (void)argc; (void)argv;
    char mac[18];
    wifi_manager_get_mac(mac, sizeof(mac));
    printf("MAC:      %s\n", mac);
    printf("Firmware: %s\n", CONFIG_VELLUM_FIRMWARE_VERSION);
    printf("Model:    %s\n", CONFIG_VELLUM_DISPLAY_MODEL);
    printf("IDF:      %s\n", esp_get_idf_version());
    return 0;
}

static int cmd_nvs_erase(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("Erasing NVS... ");
    nvs_manager_clear_all();
    printf("done. Rebooting.\n");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return 0;
}

static int cmd_reboot(int argc, char **argv)
{
    (void)argc; (void)argv;
    printf("Rebooting...\n");
    vTaskDelay(pdMS_TO_TICKS(200));
    esp_restart();
    return 0;
}

static void register_console_commands(void)
{
    esp_console_cmd_t cmds[] = {
        { .command = "wifi",      .help = "Set WiFi: wifi <ssid> <password> [server-url]", .func = &cmd_wifi },
        { .command = "server",    .help = "Get/set server URL: server [url]", .func = &cmd_server },
        { .command = "token",     .help = "Store a pre-provisioning device token", .func = &cmd_token },
        { .command = "info",      .help = "Show device info",                 .func = &cmd_info },
        { .command = "nvs-erase", .help = "Factory reset (erase NVS)",        .func = &cmd_nvs_erase },
        { .command = "reboot",    .help = "Restart device",                   .func = &cmd_reboot },
    };
    for (int i = 0; i < sizeof(cmds) / sizeof(cmds[0]); i++) {
        esp_console_cmd_register(&cmds[i]);
    }
}

/* Feed one byte to the interactive text console (echo + line editing + run). */
static void console_feed(int c, char *line_buf, size_t line_cap, int *line_pos)
{
    if (c == '\n' || c == '\r') {
        if (*line_pos > 0) {
            line_buf[*line_pos] = '\0';
            printf("\n");
            int ret;
            esp_err_t err = esp_console_run(line_buf, &ret);
            if (err == ESP_ERR_NOT_FOUND) {
                printf("Unknown command: %s\n", line_buf);
            }
            printf("vellum> ");
            fflush(stdout);
            *line_pos = 0;
        }
    } else if (c == 0x7F || c == '\b') {
        if (*line_pos > 0) {
            (*line_pos)--;
            printf("\b \b");
            fflush(stdout);
        }
    } else if (*line_pos < (int)line_cap - 1) {
        line_buf[(*line_pos)++] = (char)c;
        fputc(c, stdout);
        fflush(stdout);
    }
}

/* ── Serial task: handles both Improv and Console ─────────────── */

static void serial_task(void *arg)
{
    (void)arg;

    /* Initialize console */
    esp_console_config_t console_config = {
        .max_cmdline_args = 8,
        .max_cmdline_length = 256,
    };
    esp_console_init(&console_config);
    register_console_commands();
    esp_console_register_help_command();

    setvbuf(stdin, NULL, _IONBF, 0);

    /* CRITICAL for Improv: this one stream carries BINARY Improv frames, but the
     * stdio console VFS otherwise translates line endings (CR->LF on input,
     * LF->CRLF on output). That silently corrupts any frame byte that happens to
     * be 0x0D or 0x0A — e.g. a length or checksum byte — so the device fails the
     * frame checksum, drops the browser's WIFI_SETTINGS frame, stays silent, and
     * provisioning "times out". Force raw passthrough so binary frames survive
     * byte-exact in both directions. The text console still works: console_feed()
     * already accepts both '\r' and '\n' as line terminators. */
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
    usb_serial_jtag_vfs_set_rx_line_endings(ESP_LINE_ENDINGS_LF);
    usb_serial_jtag_vfs_set_tx_line_endings(ESP_LINE_ENDINGS_LF);
#elif CONFIG_ESP_CONSOLE_UART
    uart_vfs_dev_port_set_rx_line_endings(CONFIG_ESP_CONSOLE_UART_NUM, ESP_LINE_ENDINGS_LF);
    uart_vfs_dev_port_set_tx_line_endings(CONFIG_ESP_CONSOLE_UART_NUM, ESP_LINE_ENDINGS_LF);
#endif

    ESP_LOGI(TAG, "Vellum Console ready. Type 'help' for commands.");

    /* Read loop. One byte stream carries two things: binary Improv frames
     * (browser Wi-Fi/profile provisioning) and interactive console text. We
     * accumulate into rx_buf while the bytes remain a VIABLE Improv frame — i.e.
     * rx_buf is still a prefix of the "IMPROV" magic, or the magic already
     * matched and we are collecting the rest of the declared frame. The moment
     * the bytes can no longer be an Improv frame, we replay everything buffered
     * so far to the text console (so a word that merely starts with 'I' still
     * types normally).
     *
     * NB: the previous implementation reset rx_pos to 0 on every byte until it
     * reached 10, which it never could — so Improv frames never assembled and
     * browser provisioning silently never worked. */
    uint8_t rx_buf[256];
    int rx_pos = 0;
    char line_buf[256];
    int line_pos = 0;

    while (1) {
        int c = fgetc(stdin);
        if (c == EOF) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if (rx_pos >= (int)sizeof(rx_buf)) rx_pos = 0; /* overflow guard */
        rx_buf[rx_pos++] = (uint8_t)c;

        /* Still a viable Improv frame? (a prefix of the 6-byte magic, or past it) */
        int hdr_n = rx_pos < 6 ? rx_pos : 6;
        if (memcmp(rx_buf, IMPROV_HEADER, hdr_n) == 0) {
            if (rx_pos >= 10) {
                uint8_t data_len = rx_buf[8];
                if (rx_pos >= 10 + (int)data_len) {
                    improv_try_parse(rx_buf, rx_pos);
                    rx_pos = 0;
                    line_pos = 0; /* drop any half-typed console line */
                }
            }
            continue; /* keep buffering; never echo binary Improv bytes */
        }

        /* Not an Improv frame: replay the buffered bytes as console text. */
        uint8_t pending[sizeof(rx_buf)];
        int n = rx_pos;
        memcpy(pending, rx_buf, n);
        rx_pos = 0;
        for (int i = 0; i < n; i++) {
            console_feed(pending[i], line_buf, sizeof(line_buf), &line_pos);
        }
    }
}

/* ── Public API ───────────────────────────────────────────────── */

void vellum_serial_init(void)
{
    xTaskCreate(serial_task, "serial", 4096, NULL, 5, NULL);
    ESP_LOGI(TAG, "Serial console + Improv WiFi initialized");
}

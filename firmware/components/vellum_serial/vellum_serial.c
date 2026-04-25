/**
 * @file vellum_serial.c
 * @brief Improv WiFi Serial protocol + interactive console.
 *
 * Runs on the USB-UART serial port. Handles:
 * - Improv WiFi protocol (binary packets) for browser-based WiFi config
 * - Text console commands for developer/power-user config
 */

#include "vellum_serial.h"
#include "nvs_manager.h"
#include "wifi_manager.h"

#include <string.h>
#include <stdio.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_console.h"
#include "esp_vfs_dev.h"
#include "driver/uart.h"
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

static uint8_t s_improv_state = IMPROV_STATE_READY;

static void improv_send_packet(uint8_t type, const uint8_t *data, uint8_t len)
{
    uint8_t pkt[256];
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
    uint8_t buf[200];
    int pos = 0;
    buf[pos++] = cmd;

    int data_start = pos;
    pos++; /* placeholder for data length */

    for (int i = 0; i < count; i++) {
        int slen = strlen(strings[i]);
        buf[pos++] = (uint8_t)slen;
        memcpy(&buf[pos], strings[i], slen);
        pos += slen;
    }
    buf[data_start] = pos - data_start - 1;

    improv_send_packet(IMPROV_TYPE_RPC_RESULT, buf, pos);
}

static void improv_handle_wifi_settings(const uint8_t *data, uint8_t len)
{
    if (len < 2) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }

    uint8_t ssid_len = data[0];
    if (1 + ssid_len >= len) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }
    char ssid[33] = {0};
    memcpy(ssid, &data[1], ssid_len > 32 ? 32 : ssid_len);

    uint8_t pass_len = data[1 + ssid_len];
    char pass[65] = {0};
    if (pass_len > 0) memcpy(pass, &data[2 + ssid_len], pass_len > 64 ? 64 : pass_len);

    ESP_LOGI(TAG, "Improv: WiFi credentials received — SSID: %s", ssid);

    s_improv_state = IMPROV_STATE_PROVISIONING;
    improv_send_state();
    improv_send_error(IMPROV_ERROR_NONE);

    /* Store and connect */
    nvs_manager_store_wifi(ssid, pass);
    

    if (wifi_manager_connect_station() == WIFI_RESULT_CONNECTED) {
        s_improv_state = IMPROV_STATE_PROVISIONED;
        improv_send_state();
        const char *result[] = { "" }; /* redirect URL — empty */
        improv_send_rpc_result(IMPROV_CMD_WIFI_SETTINGS, result, 1);
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
        "esp32s3",
        CONFIG_VELLUM_DISPLAY_MODEL,
    };
    improv_send_rpc_result(IMPROV_CMD_GET_DEVICE_INFO, info, 4);
}

static void improv_handle_rpc(const uint8_t *data, uint8_t len)
{
    if (len < 2) { improv_send_error(IMPROV_ERROR_INVALID_RPC); return; }

    uint8_t cmd = data[0];
    uint8_t cmd_len = data[1];

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
        printf("Usage: wifi <ssid> <password>\n");
        return 1;
    }
    nvs_manager_store_wifi(argv[1], argv[2]);
    printf("WiFi credentials stored. Reboot to connect.\n");
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
    nvs_manager_store_server_url(argv[1]);
    printf("Server URL stored: %s\n", argv[1]);
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
        { .command = "wifi",      .help = "Set WiFi: wifi <ssid> <password>", .func = &cmd_wifi },
        { .command = "server",    .help = "Get/set server URL: server [url]", .func = &cmd_server },
        { .command = "info",      .help = "Show device info",                 .func = &cmd_info },
        { .command = "nvs-erase", .help = "Factory reset (erase NVS)",        .func = &cmd_nvs_erase },
        { .command = "reboot",    .help = "Restart device",                   .func = &cmd_reboot },
    };
    for (int i = 0; i < sizeof(cmds) / sizeof(cmds[0]); i++) {
        esp_console_cmd_register(&cmds[i]);
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

    /* Configure UART for console */
    setvbuf(stdin, NULL, _IONBF, 0);

    ESP_LOGI(TAG, "Vellum Console ready. Type 'help' for commands.");

    /* Read loop — detect Improv packets or console input */
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

        /* Accumulate for Improv detection */
        if (rx_pos < (int)sizeof(rx_buf)) {
            rx_buf[rx_pos++] = (uint8_t)c;
        }

        /* Try Improv parse */
        if (rx_pos >= 10 && memcmp(rx_buf, IMPROV_HEADER, 6) == 0) {
            if (improv_try_parse(rx_buf, rx_pos)) {
                rx_pos = 0;
                line_pos = 0;
                continue;
            }
            if (rx_pos >= (int)sizeof(rx_buf)) rx_pos = 0;
            continue;
        }

        /* Not Improv — treat as console text */
        rx_pos = 0;

        if (c == '\n' || c == '\r') {
            if (line_pos > 0) {
                line_buf[line_pos] = '\0';
                printf("\n");

                int ret;
                esp_err_t err = esp_console_run(line_buf, &ret);
                if (err == ESP_ERR_NOT_FOUND) {
                    printf("Unknown command: %s\n", line_buf);
                } else if (err == ESP_ERR_INVALID_ARG) {
                    /* empty input */
                }

                printf("vellum> ");
                fflush(stdout);
                line_pos = 0;
            }
        } else if (c == 0x7F || c == '\b') {
            if (line_pos > 0) {
                line_pos--;
                printf("\b \b");
                fflush(stdout);
            }
        } else if (line_pos < (int)sizeof(line_buf) - 1) {
            line_buf[line_pos++] = (char)c;
            fputc(c, stdout);
            fflush(stdout);
        }
    }
}

/* ── Public API ───────────────────────────────────────────────── */

void vellum_serial_init(void)
{
    xTaskCreate(serial_task, "serial", 4096, NULL, 5, NULL);
    ESP_LOGI(TAG, "Serial console + Improv WiFi initialized");
}

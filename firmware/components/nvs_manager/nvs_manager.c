/**
 * @file nvs_manager.c
 * @brief NVS storage implementation for Vellum.
 */

#include "nvs_manager.h"

#include <string.h>
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"

static const char *TAG = "nvs_mgr";

#define KEY_WIFI_SSID   "wifi_ssid"
#define KEY_WIFI_PASS   "wifi_pass"
#define KEY_TOKEN       "device_token"
#define KEY_SERVER_URL  "server_url"
#define KEY_PRIV_KEY    "ecdh_priv"
#define KEY_PUB_KEY     "ecdh_pub"

/* ---- internal helpers -------------------------------------------------- */

static esp_err_t open_nvs(nvs_handle_t *handle, nvs_open_mode_t mode)
{
    esp_err_t err = nvs_open(NVS_NAMESPACE, mode, handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open failed: %s", esp_err_to_name(err));
    }
    return err;
}

static esp_err_t read_str(const char *key, char *buf, size_t buf_len)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READONLY);
    if (err != ESP_OK) return err;

    size_t required = 0;
    err = nvs_get_str(h, key, NULL, &required);
    if (err != ESP_OK || required > buf_len) {
        nvs_close(h);
        return (err != ESP_OK) ? err : ESP_ERR_NVS_INVALID_LENGTH;
    }

    err = nvs_get_str(h, key, buf, &required);
    nvs_close(h);
    return err;
}

static esp_err_t write_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;

    err = nvs_set_str(h, key, value);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_str(%s) failed: %s", key, esp_err_to_name(err));
        nvs_close(h);
        return err;
    }

    err = nvs_commit(h);
    nvs_close(h);
    return err;
}

static bool key_exists(const char *key)
{
    nvs_handle_t h;
    if (open_nvs(&h, NVS_READONLY) != ESP_OK) return false;

    size_t len = 0;
    esp_err_t err = nvs_get_str(h, key, NULL, &len);
    nvs_close(h);
    return (err == ESP_OK && len > 1);
}

/* ---- public API -------------------------------------------------------- */

esp_err_t nvs_manager_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition issue, erasing...");
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "NVS initialized");
    }
    return err;
}

bool nvs_manager_has_wifi_credentials(void)
{
    return key_exists(KEY_WIFI_SSID) && key_exists(KEY_WIFI_PASS);
}

bool nvs_manager_has_device_token(void)
{
    return key_exists(KEY_TOKEN);
}

esp_err_t nvs_manager_get_wifi_ssid(char *buf, size_t buf_len)
{
    return read_str(KEY_WIFI_SSID, buf, buf_len);
}

esp_err_t nvs_manager_get_wifi_pass(char *buf, size_t buf_len)
{
    return read_str(KEY_WIFI_PASS, buf, buf_len);
}

esp_err_t nvs_manager_get_token(char *buf, size_t buf_len)
{
    return read_str(KEY_TOKEN, buf, buf_len);
}

esp_err_t nvs_manager_get_server_url(char *buf, size_t buf_len)
{
    return read_str(KEY_SERVER_URL, buf, buf_len);
}

esp_err_t nvs_manager_store_wifi(const char *ssid, const char *pass)
{
    if (!ssid || !pass || strlen(ssid) == 0) return ESP_ERR_INVALID_ARG;
    if (strlen(ssid) >= NVS_MAX_SSID_LEN)    return ESP_ERR_INVALID_ARG;
    if (strlen(pass) >= NVS_MAX_PASS_LEN)     return ESP_ERR_INVALID_ARG;

    esp_err_t err = write_str(KEY_WIFI_SSID, ssid);
    if (err != ESP_OK) return err;
    return write_str(KEY_WIFI_PASS, pass);
}

esp_err_t nvs_manager_store_token(const char *token)
{
    if (!token) return ESP_ERR_INVALID_ARG;
    if (strlen(token) >= NVS_MAX_TOKEN_LEN) return ESP_ERR_INVALID_ARG;
    return write_str(KEY_TOKEN, token);
}

esp_err_t nvs_manager_store_server_url(const char *url)
{
    if (!url || strlen(url) == 0) return ESP_ERR_INVALID_ARG;
    if (strlen(url) >= NVS_MAX_URL_LEN) return ESP_ERR_INVALID_ARG;
    return write_str(KEY_SERVER_URL, url);
}

esp_err_t nvs_manager_get_private_key(char *buf, size_t buf_len)
{
    return read_str(KEY_PRIV_KEY, buf, buf_len);
}

esp_err_t nvs_manager_get_public_key(char *buf, size_t buf_len)
{
    return read_str(KEY_PUB_KEY, buf, buf_len);
}

esp_err_t nvs_manager_store_keypair(const char *private_key, const char *public_key)
{
    if (!private_key || !public_key) return ESP_ERR_INVALID_ARG;
    esp_err_t err = write_str(KEY_PRIV_KEY, private_key);
    if (err != ESP_OK) return err;
    return write_str(KEY_PUB_KEY, public_key);
}

bool nvs_manager_has_keypair(void)
{
    return key_exists(KEY_PRIV_KEY) && key_exists(KEY_PUB_KEY);
}

esp_err_t nvs_manager_clear_all(void)
{
    nvs_handle_t h;
    esp_err_t err = open_nvs(&h, NVS_READWRITE);
    if (err != ESP_OK) return err;

    err = nvs_erase_all(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_erase_all failed: %s", esp_err_to_name(err));
        nvs_close(h);
        return err;
    }

    err = nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "All NVS keys erased");
    return err;
}

esp_err_t nvs_manager_set_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("vellum", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, key, value);
    nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t nvs_manager_get_str(const char *key, char *buf, size_t buf_len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("vellum", NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    err = nvs_get_str(h, key, buf, &buf_len);
    nvs_close(h);
    return err;
}

/**
 * @file buttons.c
 * @brief ESP-IDF GPIO interrupt-driven button handler.
 */

#include "buttons.h"

#include "esp_log.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "buttons";

#define DEBOUNCE_US     (50 * 1000)   /* 50 ms in microseconds */
#define HOLD_MS         5000          /* 5 seconds for SoftAP entry */

#define BTN1_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON1_GPIO)
#define BTN2_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON2_GPIO)
#define BTN3_GPIO  ((gpio_num_t)CONFIG_VELLUM_BUTTON3_GPIO)

/* ISR state — volatile for interrupt safety */
static volatile int64_t s_last_isr1 = 0;
static volatile int64_t s_last_isr2 = 0;
static volatile int64_t s_last_isr3 = 0;

static volatile bool s_btn1_pressed = false;
static volatile bool s_btn2_pressed = false;
static volatile bool s_btn3_pressed = false;

static int64_t s_btn3_press_start = 0;

/* ---- ISRs -------------------------------------------------------------- */

static void IRAM_ATTR isr_btn1(void *arg)
{
    int64_t now = esp_timer_get_time();
    if (now - s_last_isr1 > DEBOUNCE_US) {
        s_btn1_pressed = true;
        s_last_isr1 = now;
    }
}

static void IRAM_ATTR isr_btn2(void *arg)
{
    int64_t now = esp_timer_get_time();
    if (now - s_last_isr2 > DEBOUNCE_US) {
        s_btn2_pressed = true;
        s_last_isr2 = now;
    }
}

static void IRAM_ATTR isr_btn3(void *arg)
{
    int64_t now = esp_timer_get_time();
    if (now - s_last_isr3 > DEBOUNCE_US) {
        s_btn3_pressed = true;
        s_last_isr3 = now;
    }
}

/* ---- Public API -------------------------------------------------------- */

void buttons_init(void)
{
    const gpio_num_t pins[] = { BTN1_GPIO, BTN2_GPIO, BTN3_GPIO };

    for (int i = 0; i < 3; i++) {
        gpio_config_t io = {
            .pin_bit_mask = (1ULL << pins[i]),
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_NEGEDGE,
        };
        gpio_config(&io);
    }

    gpio_install_isr_service(0);
    gpio_isr_handler_add(BTN1_GPIO, isr_btn1, NULL);
    gpio_isr_handler_add(BTN2_GPIO, isr_btn2, NULL);
    gpio_isr_handler_add(BTN3_GPIO, isr_btn3, NULL);

    ESP_LOGI(TAG, "Initialized — GPIOs %d, %d, %d", BTN1_GPIO, BTN2_GPIO, BTN3_GPIO);
}

button_action_t buttons_poll(void)
{
    if (s_btn1_pressed) {
        s_btn1_pressed = false;
        ESP_LOGI(TAG, "Button 1 → REQUEST_RENDER");
        return BUTTON_ACTION_REQUEST_RENDER;
    }

    if (s_btn2_pressed) {
        s_btn2_pressed = false;
        ESP_LOGI(TAG, "Button 2 → SEND_REPORT");
        return BUTTON_ACTION_SEND_REPORT;
    }

    if (s_btn3_pressed) {
        s_btn3_pressed = false;
        s_btn3_press_start = esp_timer_get_time() / 1000; /* ms */
        ESP_LOGI(TAG, "Button 3 pressed — monitoring for hold");
    }

    if (s_btn3_press_start > 0) {
        if (gpio_get_level(BTN3_GPIO) == 0) {
            int64_t now_ms = esp_timer_get_time() / 1000;
            if (now_ms - s_btn3_press_start >= HOLD_MS) {
                s_btn3_press_start = 0;
                ESP_LOGI(TAG, "Button 3 held %dms → ENTER_SOFTAP", HOLD_MS);
                return BUTTON_ACTION_ENTER_SOFTAP;
            }
        } else {
            s_btn3_press_start = 0;
        }
    }

    return BUTTON_ACTION_NONE;
}

bool buttons_is_button3_held(void)
{
    return (gpio_get_level(BTN3_GPIO) == 0);
}

uint64_t buttons_get_wake_mask(void)
{
    return (1ULL << BTN1_GPIO) |
           (1ULL << BTN2_GPIO) |
           (1ULL << BTN3_GPIO);
}

#include <string.h>
#include "esp_log.h"
#include "esp-bsp.h"
#include "LcdTest.hpp"

using namespace std;

#define scr_act_width() lv_obj_get_width(lv_scr_act())
#define scr_act_height() lv_obj_get_height(lv_scr_act())

static const char *TAG = "LcdTest";

static TaskHandle_t color_task_handle;

LV_IMG_DECLARE(img_app_rgb);

static int8_t color_next = 0;
static uint32_t color_list[] = { 0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0x00ffff, 0xff00ff, 0xffffff, 0x000000 };

static void screen_set_color(uint32_t color)
{
    lv_obj_t *scr = lv_scr_act();
    lv_obj_set_style_bg_color(scr, lv_color_hex(color), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, LV_PART_MAIN);

    if(color & 0xff0000) {
        bsp_led_red_set(1);
    } else {
        bsp_led_red_set(0);
    }

    if(color & 0x00ff00) {
        bsp_led_green_set(1);
    } else {
        bsp_led_green_set(0);
    }

    if(color & 0x0000ff) {
        bsp_led_blue_set(1);
    } else {
        bsp_led_blue_set(0);
    }
}

LcdTest::LcdTest():
    ESP_Brookesia_PhoneApp("RGB Pixel", &img_app_rgb, true, false, false)
{
    
}

LcdTest::~LcdTest()
{

}

bool LcdTest::run(void)
{
    lv_obj_add_event_cb(lv_scr_act(), color_change_cb, LV_EVENT_GESTURE, this);
    xTaskCreatePinnedToCore(color_change_task, "Color task", 4096, this, 1, &color_task_handle, 0);
    bsp_led_red_set(1);
    bsp_led_green_set(1);
    bsp_led_blue_set(1);
    return true;
}

bool LcdTest::back(void)
{
    notifyCoreClosed();
    return true;
}

bool LcdTest::close(void)
{
    if(color_task_handle)
    {
        vTaskDelete(color_task_handle);
    }
    bsp_led_red_set(0);
    bsp_led_green_set(0);
    bsp_led_blue_set(0);
    return true;
}

bool LcdTest::init(void)
{
    color_next = 0;
    return true;
}

bool LcdTest::pause(void)
{
    return true;
}

bool LcdTest::resume(void)
{
    return true;
}

void LcdTest::color_change_task(void *arg)
{
    static uint32_t cnt = 0;
    while( 1 )
    {
        ulTaskNotifyTake( pdTRUE, portMAX_DELAY );
        ESP_LOGI(TAG, "New color: 0x%06x", color_list[color_next]);
        screen_set_color( color_list[color_next] );
    }
}

void LcdTest::color_change_cb(lv_event_t *e)
{
    bool update = false;
    int8_t max = sizeof(color_list) / sizeof(uint32_t);

    lv_event_code_t event = lv_event_get_code(e);
    if(event == LV_EVENT_GESTURE)
    {
        lv_indev_wait_release(lv_indev_get_act());
        lv_dir_t dir = lv_indev_get_gesture_dir(lv_indev_get_act());
        switch( dir )
        {
            case LV_DIR_LEFT:
                update = true;
                color_next --;
                if( color_next < 0 )
                {
                    color_next = max - 1;
                }
            break;

            case LV_DIR_RIGHT:
                update = true;
                color_next ++;
                if( color_next >= max )
                {
                    color_next = 0;
                }
            break;
        }
    }

    if(update)
    {
        update = false;
        if(color_task_handle)
        {
            xTaskNotifyGive(color_task_handle);
        }
    }
}

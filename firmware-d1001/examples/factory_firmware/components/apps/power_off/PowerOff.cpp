#include <string.h>
#include "esp_log.h"
#include "esp-bsp.h"
#include "PowerOff.hpp"

using namespace std;

#define scr_act_width() lv_obj_get_width(lv_scr_act())
#define scr_act_height() lv_obj_get_height(lv_scr_act())

static const char *TAG = "PowerOff";

LV_IMG_DECLARE(img_app_power);

static const lv_font_t* font;
static lv_obj_t *btn_power_off;

PowerOff::PowerOff():
    ESP_Brookesia_PhoneApp("Power Off", &img_app_power, true)
{
    
}

PowerOff::~PowerOff()
{

}

bool PowerOff::run(void)
{
    font = &lv_font_montserrat_24;

    btn_power_off = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn_power_off, scr_act_width() / 4, scr_act_height() / 6);
    lv_obj_align(btn_power_off, LV_ALIGN_CENTER, 0, 0);
    lv_obj_set_style_bg_color(btn_power_off, lv_color_hex(0xef5f60), LV_STATE_DEFAULT);
    lv_obj_set_style_bg_color(btn_power_off, lv_color_hex(0xff0000), LV_STATE_PRESSED);
    lv_obj_add_event_cb(btn_power_off, btn_event_cb, LV_EVENT_CLICKED, NULL);
 
    lv_obj_t* label = lv_label_create(btn_power_off);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_label_set_text(label, "POWER OFF");
    lv_obj_set_align(label, LV_ALIGN_CENTER);

    return true;
}

bool PowerOff::back(void)
{
    notifyCoreClosed();
    return true;
}

bool PowerOff::close(void)
{
    return true;
}

bool PowerOff::init(void)
{
    return true;
}

bool PowerOff::pause(void)
{
    return true;
}

bool PowerOff::resume(void)
{
    return true;
}

void PowerOff::btn_event_cb(lv_event_t *e)
{
    lv_obj_t *target = lv_event_get_target(e);
    if(target == btn_power_off)
    {
        ESP_LOGI(TAG, "POWER OFF");
        bsp_power_off();
    }
}
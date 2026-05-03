#include <string.h>
#include "esp_log.h"
#include "esp-bsp.h"
#include "TouchTest.hpp"

using namespace std;

#define scr_act_width() lv_obj_get_width(lv_scr_act())
#define scr_act_height() lv_obj_get_height(lv_scr_act())

static const char *TAG = "TouchTest";

LV_IMG_DECLARE(img_app_touch);

static lv_obj_t *canvas_disp;
static lv_color_t *canvas_buf;
static lv_draw_arc_dsc_t arc_dsc;

TouchTest::TouchTest():
    ESP_Brookesia_PhoneApp("Draw Dot", &img_app_touch, true, false, false)
{
    
}

TouchTest::~TouchTest()
{

}

bool TouchTest::run(void)
{
    lv_obj_add_event_cb(lv_scr_act(), position_change_cb, LV_EVENT_ALL, this);

    ESP_LOGI(TAG, "scr_act_width: %d, scr_act_height: %d", scr_act_width(), scr_act_height());

    canvas_buf = (lv_color_t *)heap_caps_malloc(scr_act_width() * scr_act_height() * sizeof(lv_color_t), MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM);
    if(canvas_buf)
    {
        memset(canvas_buf, 0xff, scr_act_width() * scr_act_height() * sizeof(lv_color_t));

        canvas_disp = lv_canvas_create(lv_scr_act());
        lv_canvas_set_buffer(canvas_disp, canvas_buf, scr_act_width(), scr_act_height(), LV_IMG_CF_TRUE_COLOR);
        lv_obj_center(canvas_disp);

        lv_draw_arc_dsc_init(&arc_dsc);
        arc_dsc.color = lv_color_make(0xff, 0x00, 0x00);
        arc_dsc.width = 10;
    }
    else
    {
        ESP_LOGI(TAG, "canvas malloc fail");
    }

    return true;
}

bool TouchTest::back(void)
{
    notifyCoreClosed();
    return true;
}

bool TouchTest::close(void)
{
    if(canvas_buf)
    {
        free(canvas_buf);
    }
    return true;
}

bool TouchTest::init(void)
{
    return true;
}

bool TouchTest::pause(void)
{
    return true;
}

bool TouchTest::resume(void)
{
    return true;
}

void TouchTest::position_change_cb(lv_event_t *e)
{
    lv_event_code_t code = lv_event_get_code(e);
    if(code == LV_EVENT_PRESSED || code == LV_EVENT_PRESSING)
    {
        lv_point_t p;
        lv_indev_t *indev = lv_indev_get_act();
        lv_indev_get_point(indev, &p);
        // ESP_LOGI(TAG, "Touch X: %d, Y: %d", p.x, p.y);
        lv_canvas_draw_arc(canvas_disp, p.x, p.y, 10, 0, 360, &arc_dsc);
    }
}

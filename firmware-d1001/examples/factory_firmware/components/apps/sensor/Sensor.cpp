#include <string.h>
#include "esp_log.h"
#include "esp-bsp.h"
#include "bsp_lsm6ds3.h"
#include "Sensor.hpp"

using namespace std;

#define scr_act_width() lv_obj_get_width(lv_scr_act())
#define scr_act_height() lv_obj_get_height(lv_scr_act())

static const char *TAG = "Sensor";

static TaskHandle_t _sensor_task_handle;

static uint8_t str_buf[64] = {0};

LV_IMG_DECLARE(img_app_sensor);
LV_IMG_DECLARE(img_app_red_dot);

static const lv_font_t* font;
static lv_obj_t *label_acc_x;
static lv_obj_t *label_acc_y;
static lv_obj_t *label_acc_z;
static lv_obj_t *label_gyr_x;
static lv_obj_t *label_gyr_y;
static lv_obj_t *label_gyr_z;
static lv_obj_t *label_temp;

static lv_obj_t *imu_arc;
static lv_obj_t *img_red_dot;

extern lsm6ds3_handle_t lsm6ds3;

Sensor::Sensor():
    ESP_Brookesia_PhoneApp("Sensor", &img_app_sensor, true)
{
    
}

Sensor::~Sensor()
{

}

bool Sensor::run(void)
{
    font = &lv_font_montserrat_24;

    label_acc_x = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_acc_x, font, LV_PART_MAIN);
    lv_label_set_text(label_acc_x, "Accel_X: 0");
    lv_obj_align(label_acc_x, LV_ALIGN_CENTER, -200, 0);

    label_acc_y = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_acc_y, font, LV_PART_MAIN);
    lv_label_set_text(label_acc_y, "Accel_Y: 0");
    lv_obj_align(label_acc_y, LV_ALIGN_CENTER, 0, 0);

    label_acc_z = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_acc_z, font, LV_PART_MAIN);
    lv_label_set_text(label_acc_z, "Accel_Z: 0");
    lv_obj_align(label_acc_z, LV_ALIGN_CENTER, 200, 0);

    label_gyr_x = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_gyr_x, font, LV_PART_MAIN);
    lv_label_set_text(label_gyr_x, "Gyro_X: 0");
    lv_obj_align(label_gyr_x, LV_ALIGN_CENTER, -200, 200);

    label_gyr_y = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_gyr_y, font, LV_PART_MAIN);
    lv_label_set_text(label_gyr_y, "Gyro_Y: 0");
    lv_obj_align(label_gyr_y, LV_ALIGN_CENTER, 0, 200);

    label_gyr_z = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_gyr_z, font, LV_PART_MAIN);
    lv_label_set_text(label_gyr_z, "Gyro_Z: 0");
    lv_obj_align(label_gyr_z, LV_ALIGN_CENTER, 200, 200);

    label_temp = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_temp, font, LV_PART_MAIN);
    lv_label_set_text(label_temp, "Temp: 0");
    lv_obj_align(label_temp, LV_ALIGN_CENTER, 0, 400);

    imu_arc = lv_arc_create(lv_scr_act());
    lv_obj_center(imu_arc);
    lv_obj_align(imu_arc, LV_ALIGN_CENTER, 0, -300);
    lv_obj_set_size(imu_arc, 300, 300);
    lv_arc_set_bg_start_angle(imu_arc, 0);
    lv_arc_set_bg_end_angle(imu_arc, 360);
    lv_obj_remove_style(imu_arc, NULL, LV_PART_KNOB); 
    lv_obj_clear_flag(imu_arc, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_style_arc_color(imu_arc, lv_color_hex(0x0000ff), 0);
    lv_obj_set_style_arc_width(imu_arc, 3, 0);
    lv_arc_set_value(imu_arc, 0);

    img_red_dot = lv_img_create(lv_scr_act());
    lv_obj_align(img_red_dot, LV_ALIGN_CENTER, 0, -300);
    lv_img_set_src(img_red_dot, &img_app_red_dot);
    lv_img_set_zoom(img_red_dot, 100);

    xTaskCreatePinnedToCore(sensor_task, "Sensor task", 4096, this, 2, &_sensor_task_handle, 0);
    
    return true;
}

bool Sensor::back(void)
{
    notifyCoreClosed();
    return true;
}

bool Sensor::close(void)
{
    if(_sensor_task_handle)
    {
        vTaskDelete(_sensor_task_handle);
    }
    return true;
}

bool Sensor::init(void)
{
    return true;
}

bool Sensor::pause(void)
{
    return true;
}

bool Sensor::resume(void)
{
    return true;
}

void Sensor::sensor_task(void *arg)
{
    static uint32_t run_timer = 0;
    while(1)
    {
        float ax = 0, ay = 0, az = 0;
        float gx = 0, gy = 0, gz = 0;
        float temp = 0;
        
        bsp_lsm6ds3_read_accel(&lsm6ds3, &ax, &ay, &az);
        bsp_lsm6ds3_read_gyro(&lsm6ds3, &gx, &gy, &gz);
        bsp_lsm6ds3_read_temp(&lsm6ds3, &temp);

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Accel_X: %.0f", ax);
        lv_label_set_text_fmt(label_acc_x, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Accel_Y: %.0f", ay);
        lv_label_set_text_fmt(label_acc_y, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Accel_Z: %.0f", az);
        lv_label_set_text_fmt(label_acc_z, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Gyro_X: %.1f", gx / 1000);
        lv_label_set_text_fmt(label_gyr_x, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Gyro_Y: %.1f", gy / 1000);
        lv_label_set_text_fmt(label_gyr_y, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Gyro_Z: %.1f", gz / 1000);
        lv_label_set_text_fmt(label_gyr_z, (char *)(str_buf));

        memset(str_buf, 0, sizeof(str_buf));
        sprintf((char *)(str_buf), "Temp: %.1f", temp);
        lv_label_set_text_fmt(label_temp, (char *)(str_buf));

        int a = 0, b = 0;
        a = -ay * 150 / 1000;
        b = ax * 150 / 1000;
        if(a > 150) a = 150;
        else if(a < -150) a = -150;
        if(b > 150) b = 150;
        else if(b < -150) b = -150;
        lv_obj_align(img_red_dot, LV_ALIGN_CENTER, a, -300 + b);

        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

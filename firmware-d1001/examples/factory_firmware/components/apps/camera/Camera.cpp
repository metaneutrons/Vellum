/*
 * SPDX-FileCopyrightText: 2023-2024 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include "esp_err.h"
#include "esp_log.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_video_init.h"
#include "esp_cache.h"
#include "esp_heap_caps.h"
#include "esp_private/esp_cache_private.h"
#include "esp_timer.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "driver/ppa.h"
#include "driver/jpeg_encode.h"

#include "esp-bsp.h"

#include "esp_lcd_touch_gsl3670.h"

#include "app_video.h"
#include "app_camera_pipeline.hpp"
#include "Camera.hpp"
#include "ui/ui.h"

#define ALIGN_UP_BY(num, align) (((num) + ((align) - 1)) & ~((align) - 1))

#define CAMERA_INIT_TASK_WAIT_MS            (1000)
#define DETECT_NUM_MAX                      (10)
#define FPS_PRINT                           (1)

#define CAMERA_PIC_IN_W   1280
#define CAMERA_PIC_IN_H   720

#define CAMERA_PIC_OUT_W   1280
#define CAMERA_PIC_OUT_H   800

using namespace std;

typedef enum {
    CAMERA_EVENT_TASK_RUN = BIT(0),
    CAMERA_EVENT_DELETE = BIT(1),
} camera_event_id_t;

LV_IMG_DECLARE(img_app_camera);

static const char *TAG = "Camera";

static pipeline_handle_t feed_pipeline;
static pipeline_handle_t detect_pipeline;

// Other variables
static lv_obj_t *btn_label = NULL;
static size_t data_cache_line_size = 0;
static ppa_client_handle_t ppa_client_srm_handle = NULL;
static ppa_client_handle_t ppa_srm_handle = NULL;
static EventGroupHandle_t camera_event_group;

static uint8_t *ppa_buffer[2] = {};

static jpeg_encoder_handle_t jpeg_handle;
static uint8_t shot_file_name[64] = {0};
static uint16_t shot_file_num = 0;

static uint32_t raw_size_1080p = 1280 * 720 * 2;
static uint32_t jpg_size_1080p = 0;
static size_t tx_buffer_size = 0;
static size_t rx_buffer_size = 0;
static uint8_t *raw_buf_1080p = NULL;
static uint8_t *jpg_buf_1080p = NULL;
static jpeg_encode_cfg_t enc_config;

static void camera_video_frame_operation(uint8_t *camera_buf, uint8_t camera_buf_index, 
                                    uint32_t camera_buf_hes, uint32_t camera_buf_ves, 
                                    size_t camera_buf_len);

Camera::Camera(uint16_t hor_res, uint16_t ver_res):
    ESP_Brookesia_PhoneApp("Camera", &img_app_camera, false),  // auto_resize_visual_area
    _screen_index(SCREEN_CAMERA_SHOT),
    _hor_res(hor_res),
    _ver_res(ver_res),
    _img_album_dsc_size(hor_res > ver_res ? ver_res : hor_res),
    _img_album_buffer(NULL),
    _camera_init_sem(NULL),
    _camera_ctlr_handle(0)
{
    _img_album_buf_bytes = _img_album_dsc_size * _img_album_dsc_size * sizeof(lv_color_t);
}

Camera::~Camera()
{
}

bool Camera::run(void)
{
    if (_camera_init_sem == NULL) {
        _camera_init_sem = xSemaphoreCreateBinary();
        assert(_camera_init_sem != NULL);

        xTaskCreatePinnedToCore((TaskFunction_t)taskCameraInit, "Camera Init", 4096, this, 2, NULL, 0);
        if (xSemaphoreTake(_camera_init_sem, pdMS_TO_TICKS(CAMERA_INIT_TASK_WAIT_MS)) != pdTRUE) {
            ESP_LOGE(TAG, "Camera init timeout");
            return false;
        }
        free(_camera_init_sem);
        _camera_init_sem = NULL;
    }

    for(int i=0;i<2;i++)
    {
        ppa_buffer[i] = (uint8_t *)heap_caps_aligned_alloc(data_cache_line_size, CAMERA_PIC_OUT_W *CAMERA_PIC_OUT_H *2, MALLOC_CAP_SPIRAM);
        if(!ppa_buffer[i])
        {
            ESP_LOGE(TAG,"alloc ppa_buffer[%d] failed",i);
        } else {
        memset(ppa_buffer[i], 0, CAMERA_PIC_OUT_W *CAMERA_PIC_OUT_H *2);
        }
    }

    xEventGroupSetBits(camera_event_group, CAMERA_EVENT_TASK_RUN);
    xEventGroupClearBits(camera_event_group, CAMERA_EVENT_DELETE);

    // UI initialization
    ui_camera_init();

    // The following is the additional UI initialization
    _img_album_buffer = (uint8_t *)heap_caps_aligned_alloc(128, _img_refresh_dsc.data_size, MALLOC_CAP_SPIRAM);
    if (_img_album_buffer == NULL) {
        ESP_LOGE(TAG, "Allocate memory for album buffer failed");
        return false;
    }
    lv_img_dsc_t img_dsc = {
        .header = {
            .cf = LV_IMG_CF_TRUE_COLOR,
            .always_zero = 0,
            .reserved = 0,
            .w = _hor_res,
            .h = _ver_res,
        },
        .data_size = _img_album_buf_bytes,
        .data = (const uint8_t *)_img_album_buffer,
    };
    memcpy(&_img_album_dsc, &img_dsc, sizeof(lv_img_dsc_t));

    lv_obj_refr_size(ui_PanelCameraShotAlbum);
    lv_obj_clear_flag(ui_PanelCameraShotAlbum, LV_OBJ_FLAG_CLICKABLE);

    _img_album = lv_imgbtn_create(ui_PanelCameraShotAlbum);
    lv_obj_add_flag(_img_album, LV_OBJ_FLAG_EVENT_BUBBLE);
    lv_obj_set_size(_img_album, 100, 100);
    lv_obj_center(_img_album);
    lv_obj_add_event_cb(_img_album, onScreenCameraShotAlbumClick, LV_EVENT_CLICKED, this);

    img_dsc.header.w = _hor_res;
    img_dsc.header.h = _ver_res;
    img_dsc.data_size = _img_refresh_dsc.data_size;
    memcpy(&_img_photo_dsc, &img_dsc, sizeof(lv_img_dsc_t));
    memcpy(_img_album_buffer, _img_refresh_dsc.data, _img_refresh_dsc.data_size);
    lv_obj_set_width(ui_ImageCameraPhotoImage, _hor_res);
    lv_obj_set_height(ui_ImageCameraPhotoImage, _ver_res);
    lv_img_set_src(ui_ImageCameraPhotoImage, &_img_photo_dsc);

    lv_obj_add_event_cb(ui_ButtonCameraShotBtn, onScreenCameraShotBtnClick, LV_EVENT_CLICKED, this);

    lv_obj_add_flag(ui_PanelCameraShotTitle, LV_OBJ_FLAG_HIDDEN);
    
    return true;
}

bool Camera::pause(void)
{
    xEventGroupClearBits(camera_event_group, CAMERA_EVENT_TASK_RUN);
    
    return true;
}

bool Camera::resume(void)
{
    xEventGroupSetBits(camera_event_group, CAMERA_EVENT_TASK_RUN);

    return true;
}

bool Camera::back(void)
{
    notifyCoreClosed();

    return true;
}

bool Camera::close(void)
{
    xEventGroupSetBits(camera_event_group, CAMERA_EVENT_TASK_RUN);
    xEventGroupSetBits(camera_event_group, CAMERA_EVENT_DELETE);
    
    app_video_stream_task_stop(_camera_ctlr_handle);
    app_video_stream_wait_stop();

    if (_img_album_buffer) {
        heap_caps_free(_img_album_buffer);
        _img_album_buffer = NULL;
    }

    for(int i=0;i<2;i++)
    {
        if(ppa_buffer[i])
        {
        heap_caps_free(ppa_buffer[i]);
        ppa_buffer[i] = NULL;
        }
    }

    bsp_led_red_set(0);
    bsp_led_green_set(0);
    bsp_led_blue_set(0);

    return true;
}

bool Camera::init(void)
{
    camera_event_group = xEventGroupCreate();
    xEventGroupClearBits(camera_event_group, CAMERA_EVENT_TASK_RUN);
    xEventGroupClearBits(camera_event_group, CAMERA_EVENT_DELETE);

    i2c_master_bus_handle_t i2c_bus_handle = bsp_i2c_0_get_handle();
    esp_err_t ret = app_video_main(i2c_bus_handle);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "video main init failed with error 0x%x", ret);
    }

    // Open the video device
    _camera_ctlr_handle = app_video_open(EXAMPLE_CAM_DEV_PATH, APP_VIDEO_FMT_RGB565);
    if (_camera_ctlr_handle < 0) {
        ESP_LOGE(TAG, "video cam open failed");

        if (ESP_OK == i2c_master_probe(i2c_bus_handle, ESP_LCD_TOUCH_IO_I2C_GSL3670_ADDRESS, 100)) {
            ESP_LOGI(TAG, "gsl3670 touch found");
        } else {
            ESP_LOGE(TAG, "Touch not found");
        }
    }
    ppa_client_config_t ppa_srm_config = {
        .oper_type = PPA_OPERATION_SRM,
    };
    ESP_ERROR_CHECK(ppa_register_client(&ppa_srm_config, &ppa_srm_handle));

    ESP_ERROR_CHECK(esp_cache_get_alignment(MALLOC_CAP_SPIRAM, &data_cache_line_size));
    
    for (int i = 0; i < EXAMPLE_CAM_BUF_NUM; i++) {
        _cam_buffer[i] = (uint8_t *)heap_caps_aligned_alloc(data_cache_line_size, _hor_res * _ver_res * BSP_LCD_BITS_PER_PIXEL / 8, MALLOC_CAP_SPIRAM);
        _cam_buffer_size[i] = _hor_res * _ver_res * BSP_LCD_BITS_PER_PIXEL / 8;
    }

    // Register the video frame operation callback
    ESP_ERROR_CHECK(app_video_register_frame_operation_cb(camera_video_frame_operation));

    lv_img_dsc_t img_dsc = {
        .header = {
            .cf = LV_IMG_CF_TRUE_COLOR,
            .always_zero = 0,
            .reserved = 0,
            .w = _hor_res,
            .h = _ver_res,
        },
        .data_size = _cam_buffer_size[0],
        .data = (const uint8_t *)_cam_buffer[0],
    };

    memcpy(&_img_refresh_dsc, &img_dsc, sizeof(lv_img_dsc_t));

    size_t detect_buf_size = ALIGN_UP_BY(800 * 480 * BSP_LCD_BITS_PER_PIXEL / 8, data_cache_line_size);

    ppa_client_config_t srm_config =  {
        .oper_type = PPA_OPERATION_SRM,
    };

    ESP_ERROR_CHECK(ppa_register_client(&srm_config, &ppa_client_srm_handle));

    camera_pipeline_cfg_t PPA_feed_cfg = {
        .elem_num = 1,
        .elements = NULL,
        .align_size = 1,
        .caps = MALLOC_CAP_SPIRAM,
        .buffer_size = detect_buf_size,
    };

    camera_element_pipeline_new(&PPA_feed_cfg, &feed_pipeline);

    jpeg_encode_engine_cfg_t encode_eng_cfg = {
        .timeout_ms = 70,
    };
    ESP_ERROR_CHECK(jpeg_new_encoder_engine(&encode_eng_cfg, &jpeg_handle));   

    jpeg_encode_memory_alloc_cfg_t rx_mem_cfg = {
        .buffer_direction = JPEG_ENC_ALLOC_OUTPUT_BUFFER,
    };

    jpeg_encode_memory_alloc_cfg_t tx_mem_cfg = {
        .buffer_direction = JPEG_ENC_ALLOC_INPUT_BUFFER,
    };

    enc_config.src_type = JPEG_ENCODE_IN_FORMAT_RGB565;
    enc_config.sub_sample = JPEG_DOWN_SAMPLING_YUV422;
    enc_config.image_quality = 100;
    enc_config.width = 1280;
    enc_config.height = 720;

    raw_buf_1080p = (uint8_t*)jpeg_alloc_encoder_mem(raw_size_1080p, &tx_mem_cfg, &tx_buffer_size);
    assert(raw_buf_1080p != NULL);

    jpg_buf_1080p = (uint8_t*)jpeg_alloc_encoder_mem(raw_size_1080p, &rx_mem_cfg, &rx_buffer_size); // Assume that compression ratio of 10 to 1
    assert(jpg_buf_1080p != NULL);

    return true;
}

void Camera::taskCameraInit(Camera *app)
{
    ESP_ERROR_CHECK(app_video_set_bufs(app->_camera_ctlr_handle, EXAMPLE_CAM_BUF_NUM, (const void **)app->_cam_buffer));

    ESP_LOGI(TAG, "Start camera stream task");
    ESP_ERROR_CHECK(app_video_stream_task_start(app->_camera_ctlr_handle, 0));

    xSemaphoreGive(app->_camera_init_sem);

    vTaskDelete(NULL);
}

void Camera::onScreenCameraShotAlbumClick(lv_event_t *e)
{
    lv_obj_invalidate(ui_ImageCameraPhotoImage);
}

static esp_err_t FatfsComboWrite(const void* buffer, int size, int count, FILE* stream)
{
    esp_err_t res = ESP_OK;
    res = fwrite(buffer, size, count, stream);
    res |= fflush(stream);
    res |= fsync(fileno(stream));
    return res;
}

void Camera::onScreenCameraShotBtnClick(lv_event_t *e)
{
    esp_err_t ret = ESP_OK;
    Camera *camera = (Camera *)e->user_data;

    if (camera == NULL) {
        return;
    }

    lv_obj_add_flag(camera->_img_album, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_flag(ui_PanelCameraShotAlbum, LV_OBJ_FLAG_CLICKABLE);
    lv_img_set_src(camera->_img_album, &camera->_img_album_dsc);

    xEventGroupClearBits(camera_event_group, CAMERA_EVENT_TASK_RUN);

    memcpy(camera->_img_album_buffer, camera->_img_refresh_dsc.data,
    camera->_img_refresh_dsc.data_size);

    if (bsp_sd_card_get_mount_state()) {
        memcpy(raw_buf_1080p, camera->_img_refresh_dsc.data, raw_size_1080p);
        
        ret = jpeg_encoder_process(jpeg_handle, &enc_config, raw_buf_1080p, raw_size_1080p, jpg_buf_1080p, rx_buffer_size, &jpg_size_1080p);
        if (ret == ESP_OK) {
            sprintf((char *)(shot_file_name), "/sdcard/cam_shot_%d.jpeg", shot_file_num++);
            FILE *file_cam = fopen((char *)(shot_file_name), "wb");
            int res = FatfsComboWrite(jpg_buf_1080p, jpg_size_1080p, 1, file_cam);
            fclose(file_cam);
            if (res) {
                ESP_LOGI(TAG, "save camera shot ok");
            } else {
                ESP_LOGI(TAG, "save camera shot fail");
            }
        } else {
            ESP_LOGW(TAG, "jpeg encoder process error");
        }        
    } else {
        ESP_LOGW(TAG, "sd-card unmount");
    }

    xEventGroupSetBits(camera_event_group, CAMERA_EVENT_TASK_RUN);
}

#if FPS_PRINT
typedef struct {
    int64_t start;
    int64_t acc;
    char str1[15];
    char str2[15];
} PerfCounter;
static PerfCounter perf_counters[1] = {0};

static void perfmon_start(int ctr, const char *fmt1, const char *fmt2, ...)
{
    va_list args;
    va_start(args, fmt2);
    vsnprintf(perf_counters[ctr].str1, sizeof(perf_counters[ctr].str1), fmt1, args);
    vsnprintf(perf_counters[ctr].str2, sizeof(perf_counters[ctr].str2), fmt2, args);
    va_end(args);

    perf_counters[ctr].start = esp_timer_get_time();
}

static void perfmon_end(int ctr, int count)
{
    int64_t time_diff = esp_timer_get_time() - perf_counters[ctr].start;
    float time_in_sec = (float)time_diff / 1000000;
    float frequency = count / time_in_sec;

    printf("Perf ctr[%d], [%15s][%15s]: %.2f FPS (%.2f ms per operation)\n",
        ctr, perf_counters[ctr].str1, perf_counters[ctr].str2, frequency, time_in_sec * 1000 / count);
}
#endif

static void camera_video_frame_operation(uint8_t *camera_buf, uint8_t camera_buf_index, 
                                    uint32_t camera_buf_hes, uint32_t camera_buf_ves, 
                                    size_t camera_buf_len)
{
    // Wait for task run event
    xEventGroupWaitBits(camera_event_group, CAMERA_EVENT_TASK_RUN, pdFALSE, pdTRUE, portMAX_DELAY);

    // Check if AI detection is needed
    EventBits_t current_bits = xEventGroupGetBits(camera_event_group);

    // ESP_LOGI(TAG, "camera_buf_hes: %d, camera_buf_ves: %d", camera_buf_hes, camera_buf_ves);
    ppa_srm_oper_config_t cam_srm_config = {
        .in = {
            .buffer = camera_buf,
            .pic_w = camera_buf_hes,
            .pic_h = camera_buf_ves,
            .block_w = CAMERA_PIC_IN_W,
            .block_h = CAMERA_PIC_IN_H,
            .block_offset_x = 0,
            .block_offset_y = 0,
            .srm_cm = APP_VIDEO_FMT == APP_VIDEO_FMT_RGB565 ? PPA_SRM_COLOR_MODE_RGB565 : PPA_SRM_COLOR_MODE_RGB888,
        },
        .out = {
            .buffer = ppa_buffer[camera_buf_index],
            .buffer_size = ALIGN_UP_BY(CAMERA_PIC_OUT_W * CAMERA_PIC_OUT_H * (APP_VIDEO_FMT == APP_VIDEO_FMT_RGB565 ? 2 : 3), data_cache_line_size),
            .pic_w = CAMERA_PIC_OUT_H,
            .pic_h = CAMERA_PIC_OUT_W,
            .block_offset_x = 40,
            .block_offset_y = 0,
            .srm_cm = APP_VIDEO_FMT == APP_VIDEO_FMT_RGB565 ? PPA_SRM_COLOR_MODE_RGB565 : PPA_SRM_COLOR_MODE_RGB888,
        },
        .rotation_angle =  PPA_SRM_ROTATION_ANGLE_90,
        .scale_x = 1,
        .scale_y = 1,
        .rgb_swap = 0,
        .byte_swap = 0,
        .mode = PPA_TRANS_MODE_BLOCKING,
    };
    cam_srm_config.mirror_x = 0;
    cam_srm_config.mirror_y = 1;
    int res=  ppa_do_scale_rotate_mirror(ppa_srm_handle, &cam_srm_config);

    if (!(xEventGroupGetBits(camera_event_group) & CAMERA_EVENT_DELETE)) {
        bsp_display_lock(0);
        lv_canvas_set_buffer(ui_ImageCameraShotImage, ppa_buffer[camera_buf_index], CAMERA_PIC_OUT_H, CAMERA_PIC_OUT_W, LV_IMG_CF_TRUE_COLOR);
        lv_refr_now(NULL);
        bsp_display_unlock();
    }

#if FPS_PRINT
    static int count = 0;
    if (count % 10 == 0) {
        perfmon_start(0, "PFS", "camera");
        bsp_led_red_set(0);
        bsp_led_green_set(1);
        bsp_led_blue_set(0);
    } else if (count % 10 == 9) {
        perfmon_end(0, 10);
    }
    count++;
#endif
}

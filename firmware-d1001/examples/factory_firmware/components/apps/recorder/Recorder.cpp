#include <string.h>
#include "esp_log.h"
#include "esp-bsp.h"
#include "Recorder.hpp"

using namespace std;

static const char *TAG = "Recorder";

LV_IMG_DECLARE(img_app_recorder);

#define RECORDER_TIME_MAX   30

#define scr_act_width() lv_obj_get_width(lv_scr_act())
#define scr_act_height() lv_obj_get_height(lv_scr_act())

static const lv_font_t* font;

static lv_style_t style_0;
static lv_style_t style_1;
static lv_style_t style_2;

static lv_obj_t *label_tips_1;
static lv_obj_t *label_tips_2;
static lv_obj_t *label_status;
static lv_obj_t *btn_record;
static lv_obj_t *btn_playback;
static lv_obj_t *btn_stop;

static TaskHandle_t _recorder_task_handle;
static TaskHandle_t _recorder_afe_fetch_task_handle;
static recorder_event_id_t _recorder_status;
static uint32_t _record_buf_bytes;
static int16_t *_record_data_buf;
static uint32_t _play_buf_bytes;
static int16_t *_play_data_buf;

static uint8_t record_file_name[64] = {0};
static uint16_t record_file_num = 0;

static const esp_afe_sr_iface_t *afe_handle = NULL;
static esp_afe_sr_data_t *afe_data = NULL;
static uint32_t afe_feed_read_total = 0;
static uint32_t afe_fetch_read_total = 0;

Recorder::Recorder():
    ESP_Brookesia_PhoneApp("Recorder", &img_app_recorder, true, false, false)
{
    
}

Recorder::~Recorder()
{

}

bool Recorder::run(void)
{
    afe_config_t *afe_config = afe_config_init(bsp_extra_get_input_format(), NULL, AFE_TYPE_VC, AFE_MODE_LOW_COST);
    afe_config->agc_init = true;
    afe_config->agc_compression_gain_db = 15;
    afe_config->agc_target_level_dbfs = 0;
    afe_handle = esp_afe_handle_from_config(afe_config);
    afe_data = afe_handle->create_from_config(afe_config);
    afe_config_free(afe_config);

    ESP_LOGW(TAG, "AGC compression gain %d db", afe_config->agc_compression_gain_db);
    ESP_LOGW(TAG, "AGC target level %d dbfs", - afe_config->agc_target_level_dbfs);

    _record_buf_bytes = 16000 * 2 * 4 * RECORDER_TIME_MAX; // 16 kHz * 16 bit * 4 channel * x second
    _record_data_buf = (int16_t *)heap_caps_calloc(1, _record_buf_bytes, MALLOC_CAP_SPIRAM);
    if (_record_data_buf == NULL)
    {
        ESP_LOGE(TAG, "Allocate memory for record buffer failed");
        return false;
    }

    _play_buf_bytes = 16000 * 2 * 1 * RECORDER_TIME_MAX; // 16 kHz * 16 bit * 1 channel * x second
    _play_data_buf = (int16_t *)heap_caps_calloc(1, _play_buf_bytes, MALLOC_CAP_SPIRAM);
    if (_play_data_buf == NULL)
    {
        ESP_LOGE(TAG, "Allocate memory for play buffer failed");
        return false;
    }

    xTaskCreatePinnedToCore(recorder_task, "Recorder task", 8192, this, 2, &_recorder_task_handle, 0);
    xTaskCreatePinnedToCore(recorder_afe_fetch_task, "Recorder afe task", 4096, this, 2, &_recorder_afe_fetch_task_handle, 0);

    font = &lv_font_montserrat_24;

    lv_style_init(&style_0);
    lv_style_set_bg_color(&style_0, lv_color_hex(0xefeff0));
    lv_style_set_bg_opa(&style_0, LV_OPA_COVER);

    lv_obj_t *obj = lv_obj_create(lv_scr_act());
    lv_obj_add_style(obj, &style_0, LV_PART_MAIN);
    lv_obj_set_size(obj, 800, 132);
    lv_obj_set_pos(obj, 0, 0);

    // label_tips_1 = lv_label_create(lv_scr_act());
    // lv_obj_set_style_text_font(label_tips_1, &lv_font_montserrat_20, LV_PART_MAIN);
    // lv_label_set_text(label_tips_1, "Please insert a Micro SD card.");
    // lv_obj_align(label_tips_1, LV_ALIGN_CENTER, 0, -600 );

    // label_tips_2 = lv_label_create(lv_scr_act());
    // lv_obj_set_style_text_font(label_tips_2, &lv_font_montserrat_18, LV_PART_MAIN);
    // lv_label_set_text(label_tips_2, "The device will format it to FAT32, back up your data first.");
    // lv_obj_align(label_tips_2, LV_ALIGN_CENTER, 0, -560);

    label_tips_1 = lv_label_create(obj);
    lv_obj_set_style_text_font(label_tips_1, &lv_font_montserrat_20, LV_PART_MAIN);
    lv_label_set_text(label_tips_1, "Please insert a Micro SD card.");
    lv_obj_align(label_tips_1, LV_ALIGN_CENTER, 0, -20 );

    label_tips_2 = lv_label_create(obj);
    lv_obj_set_style_text_font(label_tips_2, &lv_font_montserrat_18, LV_PART_MAIN);
    lv_label_set_text(label_tips_2, "The device will format it to FAT32, back up your data first.");
    lv_obj_align(label_tips_2, LV_ALIGN_CENTER, 0, 20);

    label_status = lv_label_create(lv_scr_act());
    lv_obj_set_style_text_font(label_status, &lv_font_montserrat_30, LV_PART_MAIN);
    lv_label_set_text(label_status, "Idle");
    lv_obj_align(label_status, LV_ALIGN_CENTER, 0, -360);

    lv_style_init(&style_1);
    lv_style_set_radius(&style_1, LV_RADIUS_CIRCLE);

    btn_record = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn_record, 229, 229);
    lv_obj_align(btn_record, LV_ALIGN_CENTER, -scr_act_width() / 4, 0);
    lv_obj_add_style(btn_record, &style_1, LV_PART_MAIN);
    lv_obj_set_style_bg_color(btn_record, lv_color_hex(0xa2de4e), LV_STATE_DEFAULT);
    lv_obj_set_style_bg_color(btn_record, lv_color_hex(0x00ff00), LV_STATE_PRESSED);
    lv_obj_add_event_cb(btn_record, btn_event_cb, LV_EVENT_CLICKED, NULL);
    
    btn_stop = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn_stop, 229, 229);
    lv_obj_align(btn_stop, LV_ALIGN_CENTER, scr_act_width() / 4, 0);
    lv_obj_add_style(btn_stop, &style_1, LV_PART_MAIN);
    lv_obj_set_style_bg_color(btn_stop, lv_color_hex(0xff4d4f), LV_STATE_DEFAULT);
    lv_obj_set_style_bg_color(btn_stop, lv_color_hex(0xff0000), LV_STATE_PRESSED);
    lv_obj_add_event_cb(btn_stop, btn_event_cb, LV_EVENT_CLICKED, NULL);
    
    btn_playback = lv_btn_create(lv_scr_act());
    lv_obj_set_size(btn_playback, 278, 91);
    lv_obj_align(btn_playback, LV_ALIGN_CENTER, 0, scr_act_height() / 3);
    lv_obj_set_style_bg_color(btn_playback, lv_color_hex(0x3662ec), LV_STATE_DEFAULT);
    lv_obj_set_style_bg_color(btn_playback, lv_color_hex(0x0000ff), LV_STATE_PRESSED);
    lv_obj_set_style_radius(btn_playback, LV_PCT(20), LV_PART_MAIN);
    lv_obj_add_event_cb(btn_playback, btn_event_cb, LV_EVENT_CLICKED, NULL);
    
    lv_obj_t *label = lv_label_create(btn_record);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_label_set_text(label, "Record");
    lv_obj_set_align(label, LV_ALIGN_CENTER);

    label = lv_label_create(btn_stop);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_label_set_text(label, "Stop");
    lv_obj_set_align(label, LV_ALIGN_CENTER);

    label = lv_label_create(btn_playback);
    lv_obj_set_style_text_font(label, font, LV_PART_MAIN);
    lv_label_set_text(label, "Play");
    lv_obj_set_align(label, LV_ALIGN_CENTER);
    
    return true;
}

bool Recorder::back(void)
{
    notifyCoreClosed();
    return true;
}

bool Recorder::close(void)
{
    if(audio_player_stop() != ESP_OK)
    {
        ESP_LOGE(TAG, "audio_player_stop failed");
    }

    if(_record_data_buf)
    {
        heap_caps_free(_record_data_buf);
        _record_data_buf = NULL;
    }

    if(_play_data_buf)
    {
        heap_caps_free(_play_data_buf);
        _play_data_buf = NULL;
    }

    if(_recorder_task_handle)
    {
        vTaskDelete(_recorder_task_handle);
    }

    if(_recorder_afe_fetch_task_handle)
    {
        vTaskDelete(_recorder_afe_fetch_task_handle);
    }

    afe_handle->destroy(afe_data);
    afe_data = NULL;

    return true;
}

bool Recorder::init(void)
{
    if (bsp_extra_player_init() != ESP_OK) {
        ESP_LOGE(TAG, "Play init with failed");
        return false;
    }
    return true;
}

bool Recorder::pause(void)
{
    return true;
}

bool Recorder::resume(void)
{
    return true;
}

static esp_err_t FatfsComboWrite(const void* buffer, int size, int count, FILE* stream)
{
    esp_err_t res = ESP_OK;
    res = fwrite(buffer, size, count, stream);
    res |= fflush(stream);
    res |= fsync(fileno(stream));
    return res;
}

void Recorder::recorder_afe_fetch_task(void *arg)
{
    int afe_chunksize = afe_handle->get_fetch_chunksize(afe_data);
    size_t byte_read = afe_chunksize * sizeof(int16_t);
    while(1)
    {
        ulTaskNotifyTake( pdTRUE, portMAX_DELAY );
        if(_recorder_status == EVENT_RECORD)
        {
            while(1)
            {
                afe_fetch_result_t *res = afe_handle->fetch(afe_data);
                if (res && res->ret_value != ESP_FAIL)
                {
                    memcpy(_play_data_buf + afe_fetch_read_total, res->data, byte_read);
                    afe_fetch_read_total += (byte_read / 2);
                    // ESP_LOGI(TAG, "afe_fetch_read_total: %u", afe_fetch_read_total);
                }
                if(_recorder_status != EVENT_RECORD)
                {
                    break;
                }
            }
        }
    }
}

void Recorder::recorder_task(void *arg)
{
    while(1)
    {
        ulTaskNotifyTake( pdTRUE, portMAX_DELAY );
RECORD:
        if(_recorder_status == EVENT_RECORD)
        {
            ESP_LOGI(TAG, "Status: recording");
            lv_label_set_text_fmt(label_status, "Recording");
            
            int feed_channel = bsp_extra_get_feed_channel();
            int audio_chunksize = afe_handle->get_feed_chunksize(afe_data);
            size_t byte_read = audio_chunksize * sizeof(int16_t) * feed_channel; // record in one chunk
            afe_feed_read_total = 0;
            afe_fetch_read_total = 0;
            memset(_record_data_buf, 0, _record_buf_bytes);
            memset(_play_data_buf, 0, _play_buf_bytes);
            xTaskNotifyGive(_recorder_afe_fetch_task_handle);
            while(1)
            {
                bsp_extra_get_feed_data(false, _record_data_buf + afe_feed_read_total, byte_read);
                afe_handle->feed(afe_data, _record_data_buf + afe_feed_read_total);
                afe_feed_read_total += (byte_read / 2);
                // ESP_LOGI(TAG, "afe_feed_read_total: %u", afe_feed_read_total);
                if(_recorder_status != EVENT_RECORD)
                {
                    break;
                }
                if(afe_feed_read_total >= (_record_buf_bytes / 2))
                {
                    break;
                }
            }

            vTaskDelay(pdMS_TO_TICKS(10));

            ESP_LOGI(TAG, "afe_feed_read_total: %u", afe_feed_read_total);
            ESP_LOGI(TAG, "afe_fetch_read_total: %u", afe_fetch_read_total);

            if(bsp_sd_card_get_mount_state())
            {
                sprintf((char *)(record_file_name), "/sdcard/record_%d.wav", record_file_num++);
                ESP_LOGI(TAG, "save record file %s", record_file_name);
                FILE *file_record = fopen((char *)(record_file_name), "wb");
                
                WavHeader header = {
                    .chunkID = {'R','I','F','F'},
                    .format = {'W','A','V','E'},
                    .subchunk1ID = {'f','m','t',' '},
                    .subchunk2ID = {'d','a','t','a'}
                };
                header.chunkSize = 36 + afe_fetch_read_total * 2; // 36 bytes for header + data size
                header.subchunk1Size = 16;
                header.audioFormat = 1; // PCM
                header.numChannels = 1; // Mono
                header.sampleRate = 16000;
                header.bitsPerSample = 16;
                header.byteRate = header.sampleRate * header.numChannels * (header.bitsPerSample / 8);
                header.blockAlign = header.numChannels * (header.bitsPerSample / 8);
                header.subchunk2Size = afe_fetch_read_total * 2;
                FatfsComboWrite(&header, sizeof(WavHeader), 1, file_record);
                FatfsComboWrite(_play_data_buf, afe_fetch_read_total * 2, 1, file_record);
                fclose(file_record);
            }
            else
            {
                ESP_LOGW(TAG, "sd-card unmount");
            }
            
            lv_label_set_text_fmt(label_status, "Record finish");

            if(_recorder_status == EVENT_RECORD)
            {
                _recorder_status = EVENT_IDLE;
            }
            else
            {
                goto RECORD;
            }
        }
        else if( _recorder_status == EVENT_PLAY )
        {
            size_t bytes_write = 0;
            ESP_LOGI(TAG, "Status: playing");
            lv_label_set_text_fmt(label_status, "Playing");

            if (bsp_sd_card_get_mount_state())
            {
                WavHeader header = { 0 };
                sprintf((char *)(record_file_name), "/sdcard/record_%d.wav", record_file_num ? record_file_num - 1: 0);

                ESP_LOGI(TAG, "open record file %s", record_file_name);
                FILE *file_record = fopen((char *)(record_file_name), "r");
                fread(&header, 1, sizeof(WavHeader), file_record);
                fclose(file_record);

                bool ret = bsp_extra_player_play_file((char *)record_file_name);
                if (ret) {
                    ESP_LOGE(TAG, "recorder play fail");
                } else {
                    ESP_LOGI(TAG, "recorder play ok");
                }

                ESP_LOGI(TAG, "record size: %u", header.subchunk2Size);

                uint32_t play_wait = 0;
                while(1)
                {
                    vTaskDelay(pdMS_TO_TICKS(1000));
                    play_wait += 1000;
                    if(play_wait >= header.subchunk2Size / 32)
                    {
                        break;
                    }
                    if(_recorder_status != EVENT_PLAY)
                    {
                        break;
                    }
                }
            }
            else
            {
                ESP_LOGW(TAG, "sd-card unmount");
            }

            lv_label_set_text_fmt(label_status, "Play finish");

            if(_recorder_status == EVENT_PLAY)
            {
                _recorder_status = EVENT_IDLE;
            }
            else
            {
                goto RECORD;
            }
        }
        else if( _recorder_status == EVENT_STOP )
        {
            ESP_LOGI(TAG, "Status: idle");
            lv_label_set_text_fmt(label_status, "Idle");
            _recorder_status = EVENT_IDLE;
        }
    }
}

void Recorder::btn_event_cb(lv_event_t *e)
{
    bool btn_toggle = false;
    lv_obj_t *target = lv_event_get_target(e);
 
    if(target == btn_record)
    {
        if(_recorder_status != EVENT_RECORD)
        {
            btn_toggle = true;
            if(_recorder_status == EVENT_PLAY)
            {
                if(audio_player_stop() != ESP_OK)
                {
                    ESP_LOGE(TAG, "audio_player_stop failed");
                }
            }
            _recorder_status = EVENT_RECORD;
        }        
    }
    else if(target == btn_playback)
    {
        if(_recorder_status != EVENT_PLAY)
        {
            btn_toggle = true;
            if(_recorder_status == EVENT_RECORD)
            {
                // NONE
            }
            _recorder_status = EVENT_PLAY;
        }
    }
    else if(target == btn_stop)
    {
        if(_recorder_status != EVENT_STOP)
        {
            btn_toggle = true;
            if(_recorder_status == EVENT_PLAY)
            {
                if(audio_player_stop() != ESP_OK)
                {
                    ESP_LOGE(TAG, "audio_player_stop failed");
                }
            }
            else if(_recorder_status == EVENT_RECORD)
            {
                // NONE
            }
            _recorder_status = EVENT_STOP;
        }
    }

    if(btn_toggle)
    {
        btn_toggle = false;
        if(_recorder_task_handle)
        {
            xTaskNotifyGive(_recorder_task_handle);
        }
    }
}

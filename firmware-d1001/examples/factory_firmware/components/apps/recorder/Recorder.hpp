#pragma once

#include "lvgl.h"
#include "bsp_board_extra.h"
#include "esp_brookesia.hpp"
#include "esp_afe_sr_models.h"

typedef enum {
    EVENT_IDLE = 0,
    EVENT_STOP = 1,
    EVENT_RECORD = 2,
    EVENT_PLAY = 3
} recorder_event_id_t;

typedef struct {
    char chunkID[4];       // "RIFF"
    uint32_t chunkSize;    // Size of the entire file minus 8 bytes
    char format[4];        // "WAVE"
    char subchunk1ID[4];   // "fmt "
    uint32_t subchunk1Size; // 16 for PCM
    uint16_t audioFormat;  // 1 for PCM
    uint16_t numChannels;
    uint32_t sampleRate;
    uint32_t byteRate;     // sampleRate * numChannels * bitsPerSample / 8
    uint16_t blockAlign;   // numChannels * bitsPerSample / 8
    uint16_t bitsPerSample;
    char subchunk2ID[4];   // "data"
    uint32_t subchunk2Size; // Size of the raw audio data
} WavHeader;

class Recorder: public ESP_Brookesia_PhoneApp
{
public:
	Recorder();
	~Recorder();

    bool run(void);
    bool back(void);
    bool close(void);

    bool init(void) override;
    bool pause(void) override;
    bool resume(void) override;
    
private:
    static void recorder_task(void *arg);
    static void recorder_afe_fetch_task(void *arg);
    static void btn_event_cb(lv_event_t * e);
};

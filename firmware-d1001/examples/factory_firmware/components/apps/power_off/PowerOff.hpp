#pragma once

#include "lvgl.h"
#include "bsp_board_extra.h"
#include "esp_brookesia.hpp"

class PowerOff: public ESP_Brookesia_PhoneApp
{
public:
	PowerOff();
	~PowerOff();

    bool run(void);
    bool back(void);
    bool close(void);

    bool init(void) override;
    bool pause(void) override;
    bool resume(void) override;
    
private:
    static void btn_event_cb(lv_event_t * e);
};

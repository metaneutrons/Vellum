#pragma once

#include "lvgl.h"
#include "bsp_board_extra.h"
#include "esp_brookesia.hpp"

class TouchTest: public ESP_Brookesia_PhoneApp
{
public:
	TouchTest();
	~TouchTest();

    bool run(void);
    bool back(void);
    bool close(void);

    bool init(void) override;
    bool pause(void) override;
    bool resume(void) override;
    
private:
    static void position_change_cb(lv_event_t *e);
};

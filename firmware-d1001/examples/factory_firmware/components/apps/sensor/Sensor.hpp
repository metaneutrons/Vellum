#pragma once

#include "lvgl.h"
#include "bsp_board_extra.h"
#include "esp_brookesia.hpp"

// Kalman structure
typedef struct {
    double Q_angle;
    double Q_bias;
    double R_measure;
    double angle;
    double bias;
    double P[2][2];
} Kalman_t;

class Sensor: public ESP_Brookesia_PhoneApp
{
public:
	Sensor();
	~Sensor();

    bool run(void);
    bool back(void);
    bool close(void);

    bool init(void) override;
    bool pause(void) override;
    bool resume(void) override;
    
private:
    static void sensor_task(void *arg);
};
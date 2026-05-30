// const baseurl = 'http://192.168.4.1'
const baseurl = window.location.origin
console.log(baseurl)
const CONSTANT = {
  wlanName: '',
  GET_BASE_URL: `${baseurl}/wlan_general`,
  GET_HIGH_URL: `${baseurl}/wlan_advance`,
}

const Ajax = {
  get: function(url,callback){
    // XMLHttpRequest对象用于在后台与服务器交换数据
    console.log('456789')
    const xhr=new XMLHttpRequest();
    xhr.open('GET', url,true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.onreadystatechange=function(){
      if(xhr.readyState === 4){
        if(xhr.status === 200 || xhr.status === 304){
          console.log(xhr.responseText);
          callback(xhr.responseText);
        } else {
          console.log(xhr.responseText);
        }
      }
    }
    xhr.send();
  },
  put: function(url, data, callback) {
    const xhr=new XMLHttpRequest();
    xhr.open('put', url,true);
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.onreadystatechange=function(){
      if(xhr.readyState === 4){
        if(xhr.status === 200 || xhr.status === 304){
          console.log(xhr.responseText);
          callback(xhr.responseText);
        } else {
          console.log(xhr.responseText);
        }
      }
    }
    xhr.send(JSON.stringify(data));
  },
  post: function(url, data, callback){
    const xhr=new XMLHttpRequest();
    xhr.open('POST', url,true);
    // 添加http头，发送信息至服务器时内容编码类型
    xhr.setRequestHeader('Content-Type','application/json');
    xhr.onreadystatechange=function(){
      console.log('1: ', xhr.readyState)
      console.log('2: ', xhr.status)
      console.log('3: ', xhr.responseText)
      if (xhr.readyState === 4){
        if (xhr.status === 200 || xhr.status === 304){
          callback(xhr.responseText);
        }
      }
    }
    xhr.send(JSON.stringify(data));
  }
}

function baseSetting() {
  const baseArray1 = document.getElementsByClassName('header-title-one')
  const base1 = baseArray1[0]
  base1.style.color = '#000'
  base1.style.cursor = 'auto'
  const baseArray = document.getElementsByClassName('header-title-two')
  const base = baseArray[0]
  base.style.color = '#888888'
  base.style.cursor = 'pointer'
  const baseShow = document.getElementById('baseShow')
  baseShow.style.display = 'block'
  const highShow = document.getElementById('highShow')
  highShow.style.display = 'none'
}

function advanceSetting() {
  console.log('点击高级设置')
  const base1 = document.querySelector('.header-title-one')
  base1.style.color = '#888888'
  base1.style.cursor = 'pointer'
  const base = document.querySelector('.header-title-two')
  base.style.color = '#000'
  base.style.cursor = 'auto'
  const baseShow = document.getElementById('baseShow')
  baseShow.style.display = 'none'
  const highShow = document.getElementById('highShow')
  highShow.style.display = 'block'
}

function baseSave() {
  const wlanName = document.getElementById('wlanName')
  console.log('wlan 名称：', wlanName.value)
  const model = document.getElementById('model')
  console.log('安全模式：', model.value)
  const password = document.getElementById('password')
  console.log('密码：', password.value)
  const select = document.getElementById('select')
  console.log('wlan 隐身：', select.checked)
  let isSelect = 'false'
  if (select.checked) {
    isSelect = 'true'
  }
  Ajax.post(CONSTANT.GET_BASE_URL, {ssid: wlanName.value, if_hide_ssid: isSelect, auth_mode: model.value, password: password.value}, function (res) {
    console.log('基本信息保存：', res)
  })
}

function highSave() {
  const broadband = document.getElementById('broadband')
  console.log('宽带：', broadband.value)
  const channel = document.getElementById('channel')
  console.log('信道：', channel.value)
  Ajax.post(CONSTANT.GET_HIGH_URL, {bandwidth: broadband.value, channel: channel.value}, function (res) {
    console.log('高级信息保存：', res)
  })
}

function menuClick (e) {
  console.log('e: ', e.classList)
  const menuView = document.getElementById('leftMenu')
  if (e.classList.contains('delMenu')) {
    menuView.style.display = 'none'
    e.classList.remove('delMenu')
  } else {
    e.classList.add('delMenu')
    menuView.style.display = 'block'
  }

}

function initHash () {
  console.log('页面第一次加载')

  const highShow = document.getElementById('highShow')
  highShow.style.display = 'none'

  Ajax.get(CONSTANT.GET_BASE_URL, function (res) {
    console.log('获取基本信息： ', res)
    res = JSON.parse(res)
    const wlanName = document.getElementById('wlanName')
    const model = document.getElementById('model')
    const password = document.getElementById('password')
    const select = document.getElementById('select')
    wlanName.value = res.ssid
    for (i = 0; i < model.length; i ++) {
      if (res.auth_mode === model.options[i].value) {
        model.options[i].selected = true
      }
    }
    password.value = res.password
    select.checked = res.if_hide_ssid === 'true'
  })
  Ajax.get(CONSTANT.GET_HIGH_URL, function (res) {
    console.log('获取高级信息', res)
    res = JSON.parse(res)
    const broadband = document.getElementById('broadband')
    const channel = document.getElementById('channel')

    for (i = 0; i < broadband.length; i ++) {
      if (res.bandwidth === broadband.options[i].value) {
        broadband.options[i].selected = true
      }
    }
    for (i = 0; i < channel.length; i ++) {
      if (res.channel === channel.options[i].value) {
        channel.options[i].selected = true
      }
    }
  })
}

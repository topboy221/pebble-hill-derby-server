require 'json'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorYodo1Mas'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'Proprietary', :text => 'Soapcube Racing' }
  s.homepage = 'https://soapcuberacing.world'
  s.author = package['author']
  s.source = { :git => 'https://soapcuberacing.world', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'Capacitor'
  s.dependency 'Yodo1MasFull', '4.18.1'   # the MAS SDK (needs the MAS-Spec source in the app's Podfile: README step 6)
end

# Control flow
x = 42

if x > 100
  puts "big"
elsif x > 20
  puts "medium"
else
  puts "small"
end

# unless
unless x.nil?
  puts "x is not nil"
end

# while
i = 0
while i < 3
  puts "i = #{i}"
  i += 1
end

# until
j = 5
until j == 0
  j -= 1
end
puts "j = #{j}"

# for..in with range
for n in 1..5
  puts n
end

# case/when
grade = "B"
result = case grade
  when "A" then "Excellent"
  when "B" then "Good"
  when "C" then "Average"
  else "Below average"
end
puts result

# begin/rescue
begin
  raise "something went wrong"
rescue => e
  puts "Rescued: #{e}"
ensure
  puts "This always runs"
end
